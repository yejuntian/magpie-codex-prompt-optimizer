(async () => {
  const token = document.querySelector('meta[name="magpie-cpo-token"]')?.content?.trim() || "";
  const $ = (id) => document.getElementById(id);
  const ui = {
    dot: $("status-dot"),
    title: $("status-title"),
    detail: $("status-detail"),
    targets: $("target-count"),
    injected: $("injected-count"),
    requests: $("request-count"),
    endpoint: $("cdp-endpoint"),
    protocol: $("protocol"),
    model: $("model"),
    baseUrl: $("base-url"),
    apiKey: $("api-key"),
    style: $("style"),
    autoAttach: $("auto-attach"),
    concise: $("prompt-concise"),
    structured: $("prompt-structured"),
    coding: $("prompt-coding"),
    message: $("message"),
    attach: $("attach"),
    launch: $("launch"),
    detach: $("detach"),
    save: $("save"),
    clearKey: $("clear-key"),
    refresh: $("refresh"),
  };
  let busy = false;
  let pollId = 0;
  let hasApiKey = false;

  async function api(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        "x-magpie-cpo-token": token,
        ...(init.headers || {}),
      },
      cache: "no-store",
      credentials: "omit",
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      throw new Error(`本地服务返回了无法解析的内容（HTTP ${response.status}）`);
    }
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function setMessage(text, kind = "") {
    ui.message.textContent = text || "";
    ui.message.className = `message ${kind}`.trim();
  }

  function setBusy(value) {
    busy = value;
    for (const button of [ui.attach, ui.detach, ui.save, ui.clearKey, ui.refresh, ui.launch]) button.disabled = value;
  }

  function applySettings(settings) {
    ui.endpoint.value = settings.cdpEndpoint || "http://127.0.0.1:9333";
    ui.protocol.value = settings.protocol || "openai";
    ui.model.value = settings.model || "";
    ui.baseUrl.value = settings.baseUrl || "";
    ui.style.value = settings.style || "structured";
    ui.autoAttach.checked = settings.autoAttach !== false;
    ui.apiKey.value = "";
    hasApiKey = settings.hasApiKey === true;
    ui.apiKey.placeholder = hasApiKey ? "已保存；留空则保持不变" : "sk-…";
    ui.concise.value = settings.systemPrompts?.concise || "";
    ui.structured.value = settings.systemPrompts?.structured || "";
    ui.coding.value = settings.systemPrompts?.coding || "";
  }

  function renderStatus(status) {
    const connected = Number(status.connectedTargets) || 0;
    const injected = Number(status.injectedTargets) || 0;
    ui.targets.textContent = String(connected);
    ui.injected.textContent = String(injected);
    ui.requests.textContent = String(Number(status.activeRequests) || 0);
    ui.dot.className = "dot";
    if (injected > 0) {
      ui.dot.classList.add("ok");
      ui.title.textContent = "已注入 Codex";
      ui.detail.textContent = `${injected} 个页面可用。回到 Codex 输入框，查看“优化”按钮。`;
    } else if (connected > 0) {
      ui.dot.classList.add("bad");
      ui.title.textContent = "已连接，但未注入";
      ui.detail.textContent = status.lastError || "点击“连接并注入”重试。";
    } else {
      ui.dot.classList.add("bad");
      ui.title.textContent = "尚未连接 Codex";
      ui.detail.textContent = status.lastError || "请启动带调试端口的 Codex，或点击“重启 Codex 并注入”。";
    }
  }

  async function refresh() {
    try {
      const result = await api("api/status");
      renderStatus(result.status);
      if (result.settings) applySettings(result.settings);
      if (!result.status?.lastError) setMessage("", "");
    } catch (error) {
      ui.dot.className = "dot bad";
      ui.title.textContent = "本地桥接服务不可用";
      ui.detail.textContent = String(error.message || error);
      setMessage(String(error.message || error), "error");
    }
  }

  function collectSettings() {
    return {
      cdpEndpoint: ui.endpoint.value.trim(),
      protocol: ui.protocol.value,
      model: ui.model.value.trim(),
      baseUrl: ui.baseUrl.value.trim(),
      apiKey: ui.apiKey.value.trim(),
      style: ui.style.value,
      autoAttach: ui.autoAttach.checked,
      systemPrompts: {
        concise: ui.concise.value,
        structured: ui.structured.value,
        coding: ui.coding.value,
      },
    };
  }

  async function saveAndInject() {
    if (busy) return;
    if (!ui.baseUrl.value.trim() || !ui.model.value.trim() || (!ui.apiKey.value.trim() && !hasApiKey)) {
      setMessage("Base URL、API Key 和模型不能为空", "error");
      return;
    }
    setBusy(true);
    setMessage("正在保存并连接 Codex…");
    try {
      const saved = await api("api/settings", { method: "POST", body: JSON.stringify(collectSettings()) });
      applySettings(saved.settings);
      const result = await api("api/inject", { method: "POST", body: "{}" });
      renderStatus(result.status);
      setMessage("已保存并注入。回到 Codex 查看输入框旁的“优化”按钮。", "ok");
    } catch (error) {
      setMessage(String(error.message || error), "error");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function attach() {
    if (busy) return;
    setBusy(true);
    setMessage("正在连接 Codex 调试端口…");
    try {
      const result = await api("api/attach", {
        method: "POST",
        body: JSON.stringify({ endpoint: ui.endpoint.value.trim() }),
      });
      renderStatus(result.status);
      setMessage("连接成功，已注入 Prompt Optimizer。", "ok");
    } catch (error) {
      setMessage(String(error.message || error), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function detach() {
    if (busy) return;
    setBusy(true);
    try {
      await api("api/detach", { method: "POST", body: "{}" });
      setMessage("已断开。已注入的按钮会在 Codex 页面重载后消失。", "ok");
      await refresh();
    } catch (error) {
      setMessage(String(error.message || error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function clearApiKey() {
    if (busy || !hasApiKey) return;
    if (!confirm("确定清除本机保存的 API Key？")) return;
    setBusy(true);
    try {
      const result = await api("api/settings", { method: "POST", body: JSON.stringify({ clearApiKey: true }) });
      applySettings(result.settings);
      setMessage("API Key 已清除。", "ok");
    } catch (error) {
      setMessage(String(error.message || error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (busy) return;
    const endpoint = ui.endpoint.value.trim();
    if (!confirm("这会先正常退出当前 Codex，再带本机调试端口重新打开。继续吗？")) return;
    setBusy(true);
    setMessage("正在重新启动 Codex 并等待调试端口…");
    try {
      const result = await api("api/launch", {
        method: "POST",
        body: JSON.stringify({ endpoint }),
      });
      renderStatus(result.status);
      setMessage("Codex 已重新启动并完成注入；后续普通重启也会自动恢复。", "ok");
    } catch (error) {
      setMessage(String(error.message || error), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  function stopPolling() {
    if (!pollId) return;
    clearInterval(pollId);
    pollId = 0;
  }

  function startPolling() {
    stopPolling();
    if (!document.hidden) pollId = setInterval(refresh, 4000);
  }

  ui.protocol.addEventListener("change", () => {
    if (ui.protocol.value === "anthropic") {
      ui.baseUrl.value = "https://api.anthropic.com";
      ui.model.value = "claude-haiku-4-5-20251001";
    } else {
      ui.baseUrl.value = "https://api.openai.com/v1";
      ui.model.value = "gpt-4o-mini";
    }
  });
  ui.save.addEventListener("click", saveAndInject);
  ui.clearKey.addEventListener("click", clearApiKey);
  ui.attach.addEventListener("click", attach);
  ui.launch.addEventListener("click", launch);
  ui.detach.addEventListener("click", detach);
  ui.refresh.addEventListener("click", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else {
      refresh();
      startPolling();
    }
  });

  if (!token) {
    setMessage("本地会话令牌缺失，请关闭后重新打开 Magpie 插件。", "error");
    return;
  }
  try {
    const settings = await api("api/settings");
    applySettings(settings);
    await refresh();
    startPolling();
  } catch (error) {
    setMessage(String(error.message || error), "error");
    ui.dot.className = "dot bad";
    ui.title.textContent = "本地桥接服务不可用";
    ui.detail.textContent = "请确认 Magpie 插件已启用，且端口 47821 未被占用。";
  }
})();
