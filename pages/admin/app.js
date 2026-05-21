const bridge = window.AstrBotPluginPage;

// ==================== 工具函数 ====================

function formatTime(timestamp) {
    if (!timestamp) return "-";
    const d = new Date(timestamp * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

async function showToast(msg, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "toast-error" : "toast-success"}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("toast-fade");
        setTimeout(() => toast.remove(), 400);
    }, 2500);
}

// ==================== 标签切换 ====================

document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        const targetId = btn.dataset.tab;
        document.getElementById(targetId).classList.add("active");

        // 切换到对应面板时加载数据
        if (targetId === "kami-panel") loadKamiList();
        else if (targetId === "records-panel") loadRecords();
        else if (targetId === "settings-panel") loadConfig();
    });
});

// ==================== 卡密管理 ====================

async function loadKamiList() {
    const container = document.getElementById("kami-list");
    container.innerHTML = '<p class="loading">加载中...</p>';

    try {
        const data = await bridge.apiGet("kami_list");
        if (data.code !== 0) {
            container.innerHTML = `<p class="error">加载失败: ${escapeHtml(data.msg)}</p>`;
            return;
        }

        const kamiList = data.data;
        const total = kamiList.length;
        const used = kamiList.filter(k => k.used).length;
        const available = total - used;

        document.getElementById("kami-stats").textContent = `共 ${total} 张 | 可用 ${available} | 已领 ${used}`;

        if (kamiList.length === 0) {
            container.innerHTML = '<p class="empty">暂无卡密，请先添加。</p>';
            return;
        }

        let html = '<table class="data-table"><thead><tr><th>卡密</th><th>状态</th><th>领取人</th><th>领取时间</th><th>操作</th></tr></thead><tbody>';
        kamiList.forEach(item => {
            const statusClass = item.used ? "status-used" : "status-available";
            const statusText = item.used ? "已领取" : "可用";
            const claimedBy = item.claimed_by
                ? `${escapeHtml(item.claimed_by.name)} (${item.claimed_by.user_id})`
                : "-";
            const claimedTime = item.claimed_time ? formatTime(item.claimed_time) : "-";
            html += `<tr>
                <td class="kami-text">${escapeHtml(item.kami)}</td>
                <td><span class="status-tag ${statusClass}">${statusText}</span></td>
                <td>${claimedBy}</td>
                <td>${claimedTime}</td>
                <td><button class="btn btn-sm btn-danger" onclick="deleteKami('${escapeHtml(item.kami)}')">删除</button></td>
            </tr>`;
        });
        html += "</tbody></table>";
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="error">请求失败: ${escapeHtml(String(e))}</p>`;
    }
}

async function addKamis() {
    const textarea = document.getElementById("kami-input");
    const raw = textarea.value.trim();
    if (!raw) {
        showToast("请输入卡密", true);
        return;
    }

    const kamis = raw.split("\n").map(s => s.trim()).filter(s => s);
    if (kamis.length === 0) {
        showToast("请输入有效卡密", true);
        return;
    }

    const btn = document.getElementById("btn-add-kami");
    btn.disabled = true;
    btn.textContent = "添加中...";

    try {
        const result = await bridge.apiPost("kami_add", { kamis });
        if (result.code === 0) {
            showToast(result.msg);
            textarea.value = "";
            await loadKamiList();
        } else {
            showToast(result.msg, true);
        }
    } catch (e) {
        showToast("请求失败: " + String(e), true);
    } finally {
        btn.disabled = false;
        btn.textContent = "添加卡密";
    }
}

async function deleteKami(kami) {
    if (!confirm(`确定要删除卡密「${kami}」吗？\n相关的领取记录也会一并清除。`)) return;

    try {
        const result = await bridge.apiPost("kami_delete", { kami });
        if (result.code === 0) {
            showToast(result.msg);
            await loadKamiList();
        } else {
            showToast(result.msg, true);
        }
    } catch (e) {
        showToast("请求失败: " + String(e), true);
    }
}

async function clearUsedKamis() {
    if (!confirm("确定要清空所有已领取记录吗？\n此操作将恢复所有卡密为可用状态，但领取记录会丢失。")) return;

    try {
        const result = await bridge.apiPost("kami_clear_used", {});
        if (result.code === 0) {
            showToast(result.msg);
            await loadKamiList();
        } else {
            showToast(result.msg, true);
        }
    } catch (e) {
        showToast("请求失败: " + String(e), true);
    }
}

// ==================== 领取记录 ====================

async function loadRecords() {
    const container = document.getElementById("records-list");
    container.innerHTML = '<p class="loading">加载中...</p>';

    try {
        const data = await bridge.apiGet("records");
        if (data.code !== 0) {
            container.innerHTML = `<p class="error">加载失败: ${escapeHtml(data.msg)}</p>`;
            return;
        }

        const records = data.data;
        document.getElementById("records-stats").textContent = `共 ${records.length} 条记录`;

        if (records.length === 0) {
            container.innerHTML = '<p class="empty">暂无领取记录。</p>';
            return;
        }

        let html = '<table class="data-table"><thead><tr><th>用户 ID</th><th>用户名</th><th>卡密</th><th>群号</th><th>领取时间</th><th>操作</th></tr></thead><tbody>';
        records.forEach(rec => {
            html += `<tr>
                <td>${escapeHtml(rec.user_id)}</td>
                <td>${escapeHtml(rec.name)}</td>
                <td class="kami-text">${escapeHtml(rec.kami)}</td>
                <td>${escapeHtml(rec.group_id)}</td>
                <td>${formatTime(rec.timestamp)}</td>
                <td><button class="btn btn-sm btn-warning" onclick="resetUser('${escapeHtml(rec.user_id)}')">重置</button></td>
            </tr>`;
        });
        html += "</tbody></table>";
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="error">请求失败: ${escapeHtml(String(e))}</p>`;
    }
}

async function resetUser(userId) {
    if (!confirm(`确定要重置用户 ${userId} 的领取状态吗？\n重置后该用户可以重新领取卡密。`)) return;

    try {
        const result = await bridge.apiPost("reset_user", { user_id: userId });
        if (result.code === 0) {
            showToast(result.msg);
            await loadRecords();
        } else {
            showToast(result.msg, true);
        }
    } catch (e) {
        showToast("请求失败: " + String(e), true);
    }
}

// ==================== 配置设置 ====================

async function loadConfig() {
    try {
        const data = await bridge.apiGet("config");
        if (data.code === 0) {
            document.getElementById("cooldown-input").value = data.data.cooldown_hours || 24;
            const whitelist = data.data.whitelist_groups || [];
            document.getElementById("whitelist-input").value = whitelist.join("\n");
        }
    } catch (e) {
        showToast("加载配置失败: " + String(e), true);
    }
}

async function saveConfig() {
    const cooldownHours = parseInt(document.getElementById("cooldown-input").value) || 0;
    const whitelistRaw = document.getElementById("whitelist-input").value.trim();
    const whitelistGroups = whitelistRaw
        ? whitelistRaw.split("\n").map(s => s.trim()).filter(s => s)
        : [];

    const btn = document.getElementById("btn-save-config");
    btn.disabled = true;
    btn.textContent = "保存中...";

    try {
        const result = await bridge.apiPost("config_update", {
            cooldown_hours: cooldownHours,
            whitelist_groups: whitelistGroups,
        });
        if (result.code === 0) {
            showToast("配置保存成功！");
        } else {
            showToast(result.msg, true);
        }
    } catch (e) {
        showToast("保存失败: " + String(e), true);
    } finally {
        btn.disabled = false;
        btn.textContent = "保存配置";
    }
}

// ==================== 事件绑定 ====================

async function init() {
    await bridge.ready();

    document.getElementById("btn-add-kami").addEventListener("click", addKamis);
    document.getElementById("btn-refresh-kami").addEventListener("click", loadKamiList);
    document.getElementById("btn-clear-used").addEventListener("click", clearUsedKamis);
    document.getElementById("btn-refresh-records").addEventListener("click", loadRecords);
    document.getElementById("btn-save-config").addEventListener("click", saveConfig);

    // 暴露 deleteKami 和 resetUser 到全局，供 onclick 调用
    window.deleteKami = deleteKami;
    window.resetUser = resetUser;

    // 初始加载
    await loadKamiList();
}

init();
