// 动态获取 bridge，避免脚本加载时 bridge SDK 尚未注入的问题
function getBridge() {
    return window.AstrBotPluginPage;
}

// ==================== 自定义确认弹窗（替代被 iframe 沙箱拦截的 confirm） ====================

function showConfirm(message) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById("confirm-modal");
        var msgEl = document.getElementById("confirm-message");
        var okBtn = document.getElementById("confirm-ok");
        var cancelBtn = document.getElementById("confirm-cancel");

        msgEl.textContent = message;
        overlay.style.display = "flex";

        function cleanup() {
            overlay.style.display = "none";
            okBtn.removeEventListener("click", onOk);
            cancelBtn.removeEventListener("click", onCancel);
        }

        function onOk() {
            cleanup();
            resolve(true);
        }

        function onCancel() {
            cleanup();
            resolve(false);
        }

        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
    });
}

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

function showToast(msg, isError) {
    isError = isError || false;
    var toast = document.createElement("div");
    toast.className = "toast " + (isError ? "toast-error" : "toast-success");
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () {
        toast.classList.add("toast-fade");
        setTimeout(function () { toast.remove(); }, 400);
    }, 2500);
}

// ==================== 事件委托：统一处理动态按钮点击 ====================

document.addEventListener("click", function (e) {
    // 删除卡密按钮 — 使用 closest 避免点到文本节点而匹配失败
    var delBtn = e.target.closest(".js-delete-kami");
    if (delBtn) {
        var kami = delBtn.getAttribute("data-kami");
        if (kami) deleteKami(kami);
        return;
    }
    // 重置用户按钮
    var resetBtn = e.target.closest(".js-reset-user");
    if (resetBtn) {
        var uid = resetBtn.getAttribute("data-uid");
        if (uid) resetUser(uid);
    }
});

// ==================== 标签切换 ====================

(function () {
    var tabs = document.querySelectorAll(".tab-btn");
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener("click", function () {
            var targetId = this.getAttribute("data-tab");
            // 切换按钮 active
            for (var j = 0; j < tabs.length; j++) {
                tabs[j].classList.remove("active");
            }
            this.classList.add("active");
            // 切换面板
            var panels = document.querySelectorAll(".panel");
            for (var k = 0; k < panels.length; k++) {
                panels[k].classList.remove("active");
            }
            var panel = document.getElementById(targetId);
            if (panel) panel.classList.add("active");
            // 加载对应数据
            if (targetId === "kami-panel") loadKamiList();
            else if (targetId === "records-panel") loadRecords();
            else if (targetId === "settings-panel") loadConfig();
        });
    }
})();

// ==================== 卡密管理 ====================

function loadKamiList() {
    var container = document.getElementById("kami-list");
    if (!container) return;
    container.innerHTML = '<p class="loading">加载中...</p>';

    getBridge().apiGet("kami_list").then(function (kamiList) {
        // bridge 已自动剥离包装，kamiList 直接就是数组
        if (!Array.isArray(kamiList)) {
            container.innerHTML = '<p class="error">数据格式异常</p>';
            return;
        }

        var total = kamiList.length;
        var used = kamiList.filter(function (k) { return k.used; }).length;
        var available = total - used;

        var stats = document.getElementById("kami-stats");
        if (stats) stats.textContent = "共 " + total + " 张 | 可用 " + available + " | 已领 " + used;

        if (kamiList.length === 0) {
            container.innerHTML = '<p class="empty">暂无卡密，请先添加。</p>';
            return;
        }

        var html = '<table class="data-table"><thead><tr><th>卡密</th><th>状态</th><th>领取人</th><th>领取时间</th><th>操作</th></tr></thead><tbody>';
        for (var i = 0; i < kamiList.length; i++) {
            var item = kamiList[i];
            var statusClass = item.used ? "status-used" : "status-available";
            var statusText = item.used ? "已领取" : "可用";
            var claimedBy = item.claimed_by
                ? escapeHtml(item.claimed_by.name) + " (" + escapeHtml(item.claimed_by.user_id) + ")"
                : "-";
            var claimedTime = item.claimed_time ? formatTime(item.claimed_time) : "-";
            html += '<tr>' +
                '<td class="kami-text">' + escapeHtml(item.kami) + '</td>' +
                '<td><span class="status-tag ' + statusClass + '">' + statusText + '</span></td>' +
                '<td>' + claimedBy + '</td>' +
                '<td>' + claimedTime + '</td>' +
                '<td><button class="btn btn-sm btn-danger js-delete-kami" data-kami="' + escapeHtml(item.kami) + '">删除</button></td>' +
                '</tr>';
        }
        html += "</tbody></table>";
        container.innerHTML = html;
    }).catch(function (e) {
        container.innerHTML = '<p class="error">请求失败: ' + escapeHtml(e.message || String(e)) + '</p>';
    });
}

function addKamis() {
    var textarea = document.getElementById("kami-input");
    var raw = textarea.value.trim();
    if (!raw) {
        showToast("请输入卡密", true);
        return;
    }

    doAddKamis(raw);
}

function doAddKamis(rawText) {
    var kamis = rawText.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (kamis.length === 0) {
        showToast("请输入有效卡密", true);
        return;
    }

    var btn = document.getElementById("btn-add-kami");
    btn.disabled = true;
    btn.textContent = "添加中...";

    // 检测 bridge 是否可用
    if (!window.AstrBotPluginPage || typeof window.AstrBotPluginPage.apiPost !== "function") {
        showToast("Bridge 未就绪，请刷新页面后重试", true);
        btn.disabled = false;
        btn.textContent = "添加卡密";
        return;
    }

    console.log("[kami] 准备添加 " + kamis.length + " 张卡密:", kamis);

    // 超时保护：15 秒后如果还没响应，恢复按钮
    var timeoutId = setTimeout(function () {
        if (btn.disabled) {
            console.error("[kami] 请求超时");
            btn.disabled = false;
            btn.textContent = "添加卡密";
            showToast("请求超时，请刷新页面后重试", true);
        }
    }, 15000);

    try {
        getBridge().apiPost("kami_add", { kamis: kamis }).then(function (result) {
            clearTimeout(timeoutId);
            console.log("[kami] 添加响应:", result);
            showToast(result.msg || "添加成功");
            document.getElementById("kami-input").value = "";
            loadKamiList();
            btn.disabled = false;
            btn.textContent = "添加卡密";
        }).catch(function (e) {
            clearTimeout(timeoutId);
            console.error("[kami] 添加失败:", e);
            showToast(e.message || "请求失败", true);
            btn.disabled = false;
            btn.textContent = "添加卡密";
        });
    } catch (e) {
        clearTimeout(timeoutId);
        console.error("[kami] 调用 apiPost 时发生同步异常:", e);
        showToast("请求异常: " + (e.message || String(e)), true);
        btn.disabled = false;
        btn.textContent = "添加卡密";
    }
}

function importFromFile() {
    var fileInput = document.getElementById("file-input");
    fileInput.click();
}

function handleFileSelected(event) {
    var file = event.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function (e) {
        var content = e.target.result;
        if (!content || !content.trim()) {
            showToast("文件内容为空", true);
            return;
        }
        // 将内容填入文本框并自动添加
        document.getElementById("kami-input").value = content;
        doAddKamis(content);
    };
    reader.onerror = function () {
        showToast("文件读取失败", true);
    };
    reader.readAsText(file, "UTF-8");
    // 重置 file input 以便重新选择同一文件
    event.target.value = "";
}

function deleteKami(kami) {
    showConfirm("确定要删除卡密「" + kami + "」吗？\n相关的领取记录也会一并清除。").then(function (ok) {
        if (!ok) return;

        if (!getBridge() || typeof getBridge().apiPost !== "function") {
            showToast("Bridge 未就绪，请刷新页面后重试", true);
            return;
        }

        console.log("[kami] 删除卡密:", kami);

        try {
            getBridge().apiPost("kami_delete", { kami: kami }).then(function (result) {
                console.log("[kami] 删除响应:", result);
                showToast(result.msg || "删除成功");
                loadKamiList();
            }).catch(function (e) {
                console.error("[kami] 删除失败:", e);
                showToast(e.message || "删除失败", true);
            });
        } catch (e) {
            console.error("[kami] 调用 apiPost 时发生同步异常:", e);
            showToast("请求异常: " + (e.message || String(e)), true);
        }
    });
}

function clearUsedKamis() {
    showConfirm("确定要一键重置吗？\n\n此操作将会：\n1. 从卡密池中删除所有已领取的旧卡密\n2. 清空所有领取记录\n\n未领取的卡密将保留。").then(function (ok) {
        if (!ok) return;

        if (!getBridge() || typeof getBridge().apiPost !== "function") {
            showToast("Bridge 未就绪，请刷新页面后重试", true);
            return;
        }

        console.log("[kami] 一键重置");

        try {
            getBridge().apiPost("kami_clear_used", {}).then(function (result) {
                console.log("[kami] 重置响应:", result);
                showToast(result.msg || "操作成功");
                loadKamiList();
            }).catch(function (e) {
                console.error("[kami] 重置失败:", e);
                showToast(e.message || "操作失败", true);
            });
        } catch (e) {
            console.error("[kami] 调用 apiPost 时发生同步异常:", e);
            showToast("请求异常: " + (e.message || String(e)), true);
        }
    });
}

function clearAllKamis() {
    showConfirm("⚠️ 确定要删除全部卡密吗？\n\n此操作不可撤销！\n将会删除所有卡密（包括未领取的）并清空领取记录。").then(function (ok) {
        if (!ok) return;

        if (!getBridge() || typeof getBridge().apiPost !== "function") {
            showToast("Bridge 未就绪，请刷新页面后重试", true);
            return;
        }

        console.log("[kami] 一键删除全部");

        try {
            getBridge().apiPost("kami_clear_all", {}).then(function (result) {
                console.log("[kami] 删除全部响应:", result);
                showToast(result.msg || "操作成功");
                loadKamiList();
            }).catch(function (e) {
                console.error("[kami] 删除全部失败:", e);
                showToast(e.message || "操作失败", true);
            });
        } catch (e) {
            console.error("[kami] 调用 apiPost 时发生同步异常:", e);
            showToast("请求异常: " + (e.message || String(e)), true);
        }
    });
}

// ==================== 领取记录 ====================

function loadRecords() {
    var container = document.getElementById("records-list");
    if (!container) return;
    container.innerHTML = '<p class="loading">加载中...</p>';

    getBridge().apiGet("records").then(function (records) {
        // bridge 已自动剥离包装，records 直接就是数组
        if (!Array.isArray(records)) {
            container.innerHTML = '<p class="error">数据格式异常</p>';
            return;
        }

        var stats = document.getElementById("records-stats");
        if (stats) stats.textContent = "共 " + records.length + " 条记录";

        if (records.length === 0) {
            container.innerHTML = '<p class="empty">暂无领取记录。</p>';
            return;
        }

        var html = '<table class="data-table"><thead><tr><th>用户 ID</th><th>用户名</th><th>卡密</th><th>群号</th><th>领取时间</th><th>操作</th></tr></thead><tbody>';
        for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            html += '<tr>' +
                '<td>' + escapeHtml(rec.user_id) + '</td>' +
                '<td>' + escapeHtml(rec.name) + '</td>' +
                '<td class="kami-text">' + escapeHtml(rec.kami) + '</td>' +
                '<td>' + escapeHtml(rec.group_id) + '</td>' +
                '<td>' + formatTime(rec.timestamp) + '</td>' +
                '<td><button class="btn btn-sm btn-warning js-reset-user" data-uid="' + escapeHtml(rec.user_id) + '">重置</button></td>' +
                '</tr>';
        }
        html += "</tbody></table>";
        container.innerHTML = html;
    }).catch(function (e) {
        container.innerHTML = '<p class="error">请求失败: ' + escapeHtml(e.message || String(e)) + '</p>';
    });
}

function resetUser(userId) {
    showConfirm("确定要重置用户 " + userId + " 的领取状态吗？\n重置后该用户可以重新领取卡密。").then(function (ok) {
        if (!ok) return;

        if (!getBridge() || typeof getBridge().apiPost !== "function") {
            showToast("Bridge 未就绪，请刷新页面后重试", true);
            return;
        }

        console.log("[kami] 重置用户:", userId);

        try {
            getBridge().apiPost("reset_user", { user_id: userId }).then(function (result) {
                console.log("[kami] 重置响应:", result);
                showToast(result.msg || "重置成功");
                loadRecords();
            }).catch(function (e) {
                console.error("[kami] 重置失败:", e);
                showToast(e.message || "重置失败", true);
            });
        } catch (e) {
            console.error("[kami] 调用 apiPost 时发生同步异常:", e);
            showToast("请求异常: " + (e.message || String(e)), true);
        }
    });
}

// ==================== 配置设置 ====================

function loadConfig() {
    getBridge().apiGet("config").then(function (cfg) {
        document.getElementById("cooldown-input").value = cfg.cooldown_hours || 24;
        var whitelist = cfg.whitelist_groups || [];
        document.getElementById("whitelist-input").value = whitelist.join("\n");
        var userWhitelist = cfg.whitelist_users || [];
        document.getElementById("user-whitelist-input").value = userWhitelist.join("\n");
    }).catch(function (e) {
        showToast("加载配置失败: " + (e.message || String(e)), true);
    });
}

function saveConfig() {
    var cooldownHours = parseInt(document.getElementById("cooldown-input").value) || 0;
    var whitelistRaw = document.getElementById("whitelist-input").value.trim();
    var whitelistGroups = whitelistRaw
        ? whitelistRaw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s; })
        : [];
    var userWhitelistRaw = document.getElementById("user-whitelist-input").value.trim();
    var whitelistUsers = userWhitelistRaw
        ? userWhitelistRaw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s; })
        : [];

    var btn = document.getElementById("btn-save-config");
    btn.disabled = true;
    btn.textContent = "保存中...";

    if (!window.AstrBotPluginPage || typeof window.AstrBotPluginPage.apiPost !== "function") {
        showToast("Bridge 未就绪，请刷新页面后重试", true);
        btn.disabled = false;
        btn.textContent = "保存配置";
        return;
    }

    console.log("[kami] 保存配置:", { cooldown_hours: cooldownHours, whitelist_groups: whitelistGroups, whitelist_users: whitelistUsers });

    var timeoutId = setTimeout(function () {
        if (btn.disabled) {
            btn.disabled = false;
            btn.textContent = "保存配置";
            showToast("请求超时，请刷新页面后重试", true);
        }
    }, 15000);

    try {
        getBridge().apiPost("config_update", {
            cooldown_hours: cooldownHours,
            whitelist_groups: whitelistGroups,
            whitelist_users: whitelistUsers,
        }).then(function (result) {
            clearTimeout(timeoutId);
            console.log("[kami] 配置保存响应:", result);
            showToast(result.msg || "配置保存成功！");
            btn.disabled = false;
            btn.textContent = "保存配置";
        }).catch(function (e) {
            clearTimeout(timeoutId);
            console.error("[kami] 配置保存失败:", e);
            showToast(e.message || "保存失败", true);
            btn.disabled = false;
            btn.textContent = "保存配置";
        });
    } catch (e) {
        clearTimeout(timeoutId);
        console.error("[kami] 调用 apiPost 时发生同步异常:", e);
        showToast("请求异常: " + (e.message || String(e)), true);
        btn.disabled = false;
        btn.textContent = "保存配置";
    }
}

// ==================== 初始化 ====================

(function () {
    // 绑定按钮事件
    var btnAdd = document.getElementById("btn-add-kami");
    if (btnAdd) btnAdd.addEventListener("click", addKamis);

    var btnImport = document.getElementById("btn-import-file");
    if (btnImport) btnImport.addEventListener("click", importFromFile);

    var fileInput = document.getElementById("file-input");
    if (fileInput) fileInput.addEventListener("change", handleFileSelected);

    var btnRefresh = document.getElementById("btn-refresh-kami");
    if (btnRefresh) btnRefresh.addEventListener("click", loadKamiList);

    var btnClear = document.getElementById("btn-clear-used");
    if (btnClear) btnClear.addEventListener("click", clearUsedKamis);

    var btnClearAll = document.getElementById("btn-clear-all");
    if (btnClearAll) btnClearAll.addEventListener("click", clearAllKamis);

    var btnRecords = document.getElementById("btn-refresh-records");
    if (btnRecords) btnRecords.addEventListener("click", loadRecords);

    var btnSave = document.getElementById("btn-save-config");
    if (btnSave) btnSave.addEventListener("click", saveConfig);

    // 等待 bridge 就绪后加载初始数据
    if (window.AstrBotPluginPage && typeof window.AstrBotPluginPage.ready === "function") {
        getBridge().ready().then(function () {
            console.log("[kami] Bridge 就绪，加载卡密列表");
            loadKamiList();
        }).catch(function (e) {
            console.warn("[kami] Bridge ready 失败:", e, "，仍然尝试加载");
            loadKamiList();
        });
    } else {
        console.warn("[kami] Bridge 未就绪，延迟加载");
        // 稍后重试
        setTimeout(function () {
            loadKamiList();
        }, 1000);
    }
})();

