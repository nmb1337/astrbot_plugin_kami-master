import asyncio
import json
import time
from typing import List, Dict, Optional

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
from astrbot.api import logger, AstrBotConfig
from astrbot.api.message_components import Plain, At
from quart import jsonify, request

PLUGIN_NAME = "astrbot_plugin_kami"


@register(PLUGIN_NAME, "YourName", "群内卡密发放插件，支持群白名单、领取冷却、WebUI 管理卡密池。", "1.0.0")
class KamiPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

        # 注册 Web API 路由
        context.register_web_api(
            f"/{PLUGIN_NAME}/kami_list",
            self.api_kami_list,
            ["GET"],
            "获取所有卡密列表",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/kami_add",
            self.api_kami_add,
            ["POST"],
            "批量添加卡密",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/kami_delete",
            self.api_kami_delete,
            ["POST"],
            "删除指定卡密",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/kami_clear_used",
            self.api_kami_clear_used,
            ["POST"],
            "清空已领取的卡密",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/records",
            self.api_records,
            ["GET"],
            "获取领取记录",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/reset_user",
            self.api_reset_user,
            ["POST"],
            "重置用户领取状态",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/whitelist",
            self.api_whitelist,
            ["GET"],
            "获取群白名单",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/whitelist_update",
            self.api_whitelist_update,
            ["POST"],
            "更新群白名单",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/config",
            self.api_get_config,
            ["GET"],
            "获取插件配置",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/config_update",
            self.api_update_config,
            ["POST"],
            "更新插件配置",
        )

    # ==================== KV 数据读写 ====================

    async def _get_kami_pool(self) -> list:
        """获取可用卡密池"""
        data = await self.get_kv_data("kami_pool", [])
        return data if data else []

    async def _save_kami_pool(self, pool: list):
        """保存卡密池"""
        await self.put_kv_data("kami_pool", pool)

    async def _get_used_kamis(self) -> list:
        """获取已被领取的卡密列表"""
        data = await self.get_kv_data("kami_used", [])
        return data if data else []

    async def _save_used_kamis(self, used: list):
        """保存已领取卡密列表"""
        await self.put_kv_data("kami_used", used)

    async def _get_claim_records(self) -> dict:
        """获取领取记录 {user_id: {"kami": "xxx", "timestamp": 123, "group_id": "xxx"}}"""
        data = await self.get_kv_data("claim_records", {})
        return data if data else {}

    async def _save_claim_records(self, records: dict):
        """保存领取记录"""
        await self.put_kv_data("claim_records", records)

    async def _get_whitelist(self) -> list:
        """获取群白名单（优先从 KV 读取，否则从 config 读取）"""
        data = await self.get_kv_data("whitelist_groups", None)
        if data is not None:
            return data
        # 回退到 config 中的配置
        cfg_list = self.config.get("whitelist_groups", [])
        return [str(g) for g in cfg_list]

    async def _save_whitelist(self, whitelist: list):
        """保存群白名单"""
        await self.put_kv_data("whitelist_groups", whitelist)

    async def _get_cooldown_hours(self) -> int:
        """获取冷却时间（小时）"""
        data = await self.get_kv_data("cooldown_hours", None)
        if data is not None:
            return data
        return self.config.get("cooldown_hours", 24)

    async def _save_cooldown_hours(self, hours: int):
        """保存冷却时间"""
        await self.put_kv_data("cooldown_hours", hours)

    async def _get_claim_command(self) -> str:
        """获取领取指令（优先从 KV 读取，否则从 config 读取）"""
        data = await self.get_kv_data("claim_command", None)
        if data is not None:
            return data
        return self.config.get("claim_command", "getkami")

    async def _save_claim_command(self, cmd: str):
        """保存领取指令"""
        await self.put_kv_data("claim_command", cmd)

    # ==================== 指令 ====================

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def _on_group_message(self, event: AstrMessageEvent):
        """监听群消息，匹配可配置的领取指令"""
        msg = event.message_str.strip()
        claim_cmd = await self._get_claim_command()

        # 匹配 /指令 格式（如 /getkami、/领取）
        if not msg or not (msg == "/" + claim_cmd or msg.startswith("/" + claim_cmd + " ")):
            return  # 不是领取指令，交给其他 handler 处理

        # 调用实际的领取逻辑
        async for result in self._do_get_kami(event):
            yield result

    async def _do_get_kami(self, event: AstrMessageEvent):
        """领取卡密的核心逻辑"""
        group_id = event.message_obj.group_id
        sender_id = event.get_sender_id()
        sender_name = event.get_sender_name()

        # 1. 检查群白名单
        whitelist = await self._get_whitelist()
        if whitelist and str(group_id) not in whitelist:
            yield event.plain_result("⚠️ 本群不在卡密功能白名单内，无法使用该功能。")
            event.stop_event()
            return

        # 2. 检查冷却时间
        cooldown_hours = await self._get_cooldown_hours()
        records = await self._get_claim_records()
        if cooldown_hours > 0 and sender_id in records:
            last_claim = records[sender_id]
            last_time = last_claim.get("timestamp", 0)
            elapsed = time.time() - last_time
            if elapsed < cooldown_hours * 3600:
                remaining = cooldown_hours * 3600 - elapsed
                hours = int(remaining // 3600)
                minutes = int((remaining % 3600) // 60)
                yield event.plain_result(
                    f"⏳ {sender_name}，你还需要等待 {hours} 小时 {minutes} 分钟才能再次领取卡密。"
                )
                event.stop_event()
                return

        # 3. 从卡密池取一个未使用的卡密
        kami_pool = await self._get_kami_pool()
        used_kamis = await self._get_used_kamis()
        available = [k for k in kami_pool if k not in used_kamis]

        if not available:
            yield event.plain_result("😔 抱歉，卡密已经发完了，请联系管理员补充。")
            event.stop_event()
            return

        kami = available[0]
        used_kamis.append(kami)
        await self._save_used_kamis(used_kamis)

        # 4. 记录领取
        records[sender_id] = {
            "kami": kami,
            "timestamp": time.time(),
            "group_id": str(group_id),
            "sender_name": sender_name,
        }
        await self._save_claim_records(records)

        # 5. 尝试私发卡密
        success = await self._send_private_message(event, sender_id, kami)
        if success:
            logger.info(f"用户 {sender_name}({sender_id}) 领取卡密成功，已私发。")
            yield event.plain_result(f"✅ {sender_name}，卡密已私发给你，请查看私聊消息~")
        else:
            # 私发失败，在群里提示（不暴露卡密内容）
            logger.warning(f"私发卡密给 {sender_id} 失败，可能未添加好友或私聊不可达。")
            yield event.plain_result(
                f"⚠️ {sender_name}，卡密私发失败，请确认你已添加机器人为好友并开启了私聊。\n"
                f"如无法私聊，请联系管理员手动发放。"
            )
            # 回滚：把卡密放回去
            used_kamis.remove(kami)
            await self._save_used_kamis(used_kamis)
            records.pop(sender_id, None)
            await self._save_claim_records(records)

        event.stop_event()

    @filter.command("resetkami", alias={"重置卡密", "重置领取"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_reset_kami(self, event: AstrMessageEvent):
        """重置卡密领取状态 — 管理员指令，可重置指定用户或自己"""
        message_str = event.message_str.strip()
        sender_id = event.get_sender_id()

        records = await self._get_claim_records()

        # 默认重置自己
        target_id = sender_id
        target_name = event.get_sender_name()

        # 检查是否有 At
        messages = event.get_messages()
        for msg in messages:
            if hasattr(msg, "qq") and msg.qq:
                target_id = str(msg.qq)
                break

        # 也尝试从纯文本解析 user_id
        if target_id == sender_id:
            parts = message_str.split()
            if len(parts) > 1:
                potential_id = parts[1].strip()
                if potential_id.isdigit():
                    target_id = potential_id

        if target_id not in records:
            yield event.plain_result(f"ℹ️ 用户 {target_id} 没有领取记录，无需重置。")
            event.stop_event()
            return

        records.pop(target_id, None)
        await self._save_claim_records(records)
        logger.info(f"管理员 {sender_id} 重置了用户 {target_id} 的卡密领取状态。")
        yield event.plain_result(f"✅ 已重置用户 {target_id} 的卡密领取状态，该用户可以重新领取。")
        event.stop_event()

    @filter.command("kami_status", alias={"卡密状态"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_kami_status(self, event: AstrMessageEvent):
        """查看卡密池状态 — 管理员指令"""
        kami_pool = await self._get_kami_pool()
        used_kamis = await self._get_used_kamis()
        records = await self._get_claim_records()
        whitelist = await self._get_whitelist()
        cooldown_hours = await self._get_cooldown_hours()

        total = len(kami_pool)
        used = len(used_kamis)
        available = total - used

        msg = (
            f"📊 **卡密池状态**\n"
            f"总卡密数：{total}\n"
            f"已领取：{used}\n"
            f"剩余：{available}\n"
            f"冷却时间：{cooldown_hours} 小时\n"
            f"白名单群数：{len(whitelist)}\n"
            f"领取记录数：{len(records)}"
        )
        yield event.plain_result(msg)
        event.stop_event()

    # ==================== 私发消息 ====================

    async def _send_private_message(
        self, event: AstrMessageEvent, target_user_id: str, kami: str
    ) -> bool:
        """尝试给用户发送私聊卡密消息，返回是否成功"""
        try:
            # 从 unified_msg_origin 提取适配器类型
            umo = event.unified_msg_origin
            parts = umo.split("|")
            if len(parts) >= 3:
                adapter_type = parts[0]
                private_umo = f"{adapter_type}|private|{target_user_id}"
            else:
                # 回退：直接修改 group 为 private
                private_umo = umo.replace("|group|", "|private|")

            chain = [
                Plain(
                    f"🎫 你领取的卡密是：\n\n{kami}\n\n"
                    f"请妥善保管，不要泄露给他人。\n"
                    f"如有问题请联系管理员。"
                )
            ]
            await self.context.send_message(private_umo, chain)
            return True
        except Exception as e:
            logger.error(f"私发卡密失败: {e}")
            return False

    # ==================== Web API ====================

    async def api_kami_list(self):
        """GET — 获取所有卡密列表"""
        pool = await self._get_kami_pool()
        used = await self._get_used_kamis()
        records = await self._get_claim_records()

        kami_list = []
        for k in pool:
            is_used = k in used
            claimed_by = None
            claimed_time = None
            if is_used:
                for uid, rec in records.items():
                    if rec.get("kami") == k:
                        claimed_by = {
                            "user_id": uid,
                            "name": rec.get("sender_name", ""),
                        }
                        claimed_time = rec.get("timestamp", 0)
                        break
            kami_list.append({
                "kami": k,
                "used": is_used,
                "claimed_by": claimed_by,
                "claimed_time": claimed_time,
            })
        return jsonify({"code": 0, "data": kami_list})

    async def api_kami_add(self):
        """POST — 批量添加卡密 {kamis: ["xxx", "yyy"]}"""
        try:
            body = await request.get_json()
            new_kamis = body.get("kamis", [])
            if not new_kamis:
                return jsonify({"code": 1, "msg": "卡密列表不能为空"})

            # 去重
            pool = await self._get_kami_pool()
            existing = set(pool)
            added = []
            for k in new_kamis:
                k = k.strip()
                if k and k not in existing:
                    pool.append(k)
                    existing.add(k)
                    added.append(k)

            await self._save_kami_pool(pool)
            logger.info(f"添加了 {len(added)} 张卡密")
            return jsonify({"code": 0, "msg": f"成功添加 {len(added)} 张卡密", "added": len(added)})
        except Exception as e:
            logger.error(f"添加卡密失败: {e}")
            return jsonify({"code": 1, "msg": str(e)})

    async def api_kami_delete(self):
        """POST — 删除指定卡密 {kami: "xxx"}"""
        try:
            body = await request.get_json()
            kami = body.get("kami", "").strip()
            if not kami:
                return jsonify({"code": 1, "msg": "请指定要删除的卡密"})

            pool = await self._get_kami_pool()
            used = await self._get_used_kamis()

            if kami in pool:
                pool.remove(kami)
            if kami in used:
                used.remove(kami)

            # 同时清理相关领取记录
            records = await self._get_claim_records()
            to_delete = [uid for uid, rec in records.items() if rec.get("kami") == kami]
            for uid in to_delete:
                records.pop(uid, None)

            await self._save_kami_pool(pool)
            await self._save_used_kamis(used)
            await self._save_claim_records(records)
            logger.info(f"删除了卡密: {kami}")
            return jsonify({"code": 0, "msg": "卡密已删除"})
        except Exception as e:
            logger.error(f"删除卡密失败: {e}")
            return jsonify({"code": 1, "msg": str(e)})

    async def api_kami_clear_used(self):
        """POST — 一键重置：清除所有已领取的旧卡密（从卡密池中移除已使用的卡密，清空使用记录和领取记录）"""
        try:
            pool = await self._get_kami_pool()
            used = await self._get_used_kamis()
            # 从卡密池中移除所有已使用的卡密，只保留未使用的
            new_pool = [k for k in pool if k not in used]
            removed_count = len(pool) - len(new_pool)
            await self._save_kami_pool(new_pool)
            await self._save_used_kamis([])
            await self._save_claim_records({})
            logger.info(f"一键重置完成，清除了 {removed_count} 张旧卡密")
            return jsonify({
                "code": 0,
                "msg": f"一键重置完成！已清除 {removed_count} 张已领取的旧卡密，剩余 {len(new_pool)} 张可用卡密。"
            })
        except Exception as e:
            logger.error(f"清空记录失败: {e}")
            return jsonify({"code": 1, "msg": str(e)})

    async def api_records(self):
        """GET — 获取领取记录"""
        records = await self._get_claim_records()
        # 转换为列表便于前端展示
        record_list = []
        for uid, rec in records.items():
            record_list.append({
                "user_id": uid,
                "name": rec.get("sender_name", ""),
                "kami": rec.get("kami", ""),
                "timestamp": rec.get("timestamp", 0),
                "group_id": rec.get("group_id", ""),
            })
        # 按时间倒序
        record_list.sort(key=lambda x: x["timestamp"], reverse=True)
        return jsonify({"code": 0, "data": record_list})

    async def api_reset_user(self):
        """POST — 重置用户领取状态 {user_id: "xxx"}"""
        try:
            body = await request.get_json()
            user_id = body.get("user_id", "").strip()
            if not user_id:
                return jsonify({"code": 1, "msg": "请指定用户 ID"})

            records = await self._get_claim_records()
            if user_id in records:
                records.pop(user_id)
                await self._save_claim_records(records)
                logger.info(f"管理员重置了用户 {user_id} 的领取状态")
                return jsonify({"code": 0, "msg": f"已重置用户 {user_id} 的领取状态"})
            else:
                return jsonify({"code": 0, "msg": f"用户 {user_id} 没有领取记录"})
        except Exception as e:
            logger.error(f"重置用户失败: {e}")
            return jsonify({"code": 1, "msg": str(e)})

    async def api_whitelist(self):
        """GET — 获取群白名单"""
        whitelist = await self._get_whitelist()
        return jsonify({"code": 0, "data": whitelist})

    async def api_whitelist_update(self):
        """POST — 更新群白名单 {groups: ["123", "456"]}"""
        try:
            body = await request.get_json()
            groups = body.get("groups", [])
            groups = [str(g).strip() for g in groups if str(g).strip()]
            await self._save_whitelist(groups)
            logger.info(f"群白名单已更新: {groups}")
            return jsonify({"code": 0, "msg": f"白名单已更新，当前 {len(groups)} 个群", "data": groups})
        except Exception as e:
            logger.error(f"更新白名单失败: {e}")
            return jsonify({"code": 1, "msg": str(e)})

    async def api_get_config(self):
        """GET — 获取插件配置"""
        cooldown = await self._get_cooldown_hours()
        whitelist = await self._get_whitelist()
        claim_cmd = await self._get_claim_command()
        return jsonify({
            "code": 0,
            "data": {
                "claim_command": claim_cmd,
                "cooldown_hours": cooldown,
                "whitelist_groups": whitelist,
            }
        })

    async def api_update_config(self):
        """POST — 更新插件配置 {claim_command, cooldown_hours, whitelist_groups}"""
        try:
            body = await request.get_json()
            if "claim_command" in body:
                cmd = str(body["claim_command"]).strip()
                if cmd:
                    await self._save_claim_command(cmd)
            if "cooldown_hours" in body:
                hours = int(body["cooldown_hours"])
                await self._save_cooldown_hours(hours)
            if "whitelist_groups" in body:
                groups = [str(g).strip() for g in body["whitelist_groups"] if str(g).strip()]
                await self._save_whitelist(groups)
            logger.info("插件配置已更新")
            return jsonify({"code": 0, "msg": "配置已更新"})
        except Exception as e:
            logger.error(f"更新配置失败: {e}")
            return jsonify({"code": 1, "msg": str(e)})

    # ==================== 生命周期 ====================

    async def initialize(self):
        """插件初始化"""
        logger.info(f"{PLUGIN_NAME} 插件已初始化")

    async def terminate(self):
        """插件卸载"""
        logger.info(f"{PLUGIN_NAME} 插件已卸载")
