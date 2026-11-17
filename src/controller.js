import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { normalizeCdpEndpoint, publicSettings } from "./config.js";
import { buildLlmRequest, parseLlmResponse, performProxyRequest } from "./llm.js";

const INJECTION_PATH = new URL("../injected/prompt-optimizer.js", import.meta.url);
const DISCOVERY_INTERVAL_MS = 4_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isInjectableTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || "");
  return !/^(devtools:|chrome-extension:|chrome:)/i.test(url);
}

function scoreTarget(target) {
  const url = `${target.url || ""} ${target.title || ""}`;
  let score = 0;
  if (/codex|chatgpt/i.test(url)) score += 20;
  if (/^app:/i.test(target.url || "")) score += 20;
  if (/composer|workspace|chat/i.test(url)) score += 5;
  return score;
}

class CdpSession {
  constructor(target, endpoint, hooks) {
    this.target = target;
    this.endpoint = endpoint;
    this.hooks = hooks;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = true;
    this.injected = false;
    this.injectTimer = null;
  }

  async connect() {
    if (typeof WebSocket !== "function") throw new Error("当前运行时没有 WebSocket，请使用 Node 22+ 或 Magpie 自带 Bun");
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.target.webSocketDebuggerUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // A timed-out socket is already unusable.
        }
        reject(new Error("连接 Codex 调试端口超时"));
      }, 5_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.closed = false;
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        if (this.closed) reject(new Error("Codex 调试端口拒绝连接"));
      });
      ws.addEventListener("message", (event) => {
        Promise.resolve(this.onMessage(event.data)).catch((error) => this.hooks.onError?.(error, this.target));
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        this.closed = true;
        this.injected = false;
        for (const { reject: fail } of this.pending.values()) fail(new Error("Codex 调试连接已关闭"));
        this.pending.clear();
        this.hooks.onClose?.(this.target);
      }, { once: true });
    });
  }

  async onMessage(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data?.text) text = await data.text();
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失败"));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === "Runtime.bindingCalled") {
      const { name, payload } = message.params || {};
      if (name === "magpieCpoBridge") this.hooks.onBinding?.(this, String(payload || ""));
      return;
    }
    if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) {
      this.hooks.onNavigated?.(this);
    }
  }

  send(method, params = {}, timeoutMs = 10_000) {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex 调试连接未打开"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      userGesture: false,
      includeCommandLineAPI: false,
      silent: false,
    });
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "页面脚本执行失败";
      throw new Error(description);
    }
    return result?.result;
  }

  async inject(source, settings) {
    if (this.closed) throw new Error("Codex 调试连接已关闭");
    await this.send("Runtime.enable");
    await this.send("Page.enable").catch(() => {});
    await this.send("Runtime.addBinding", { name: "magpieCpoBridge" }).catch(async (error) => {
      if (!/already|exists|context/i.test(error.message)) throw error;
    });
    const bootstrap = JSON.stringify(settings).replace(/</g, "\\u003c");
    await this.evaluate(`globalThis.__MAGPIE_CPO_BOOTSTRAP__ = ${bootstrap}; true;`);
    const result = await this.evaluate(source, false);
    if (result?.subtype === "error") throw new Error(result.description || "提示词优化器注入失败");
    this.injected = true;
    return { targetId: this.target.id, url: this.target.url };
  }

  scheduleInject(task, ms = 350) {
    clearTimeout(this.injectTimer);
    this.injectTimer = setTimeout(() => Promise.resolve(task()).catch((error) => this.hooks.onError?.(error, this.target)), ms);
  }

  close() {
    clearTimeout(this.injectTimer);
    this.injected = false;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Closing an already closed socket is harmless.
    }
  }
}

export class PromptOptimizerController {
  constructor(initialSettings, options = {}) {
    this.settings = initialSettings;
    this.onSettingsChanged = options.onSettingsChanged || (async () => {});
    this.sessions = new Map();
    this.endpoint = initialSettings.cdpEndpoint;
    this.pollId = null;
    this.discovering = false;
    this.lastError = "";
    this.requests = new Map();
    this.injectionSource = null;
    this.lastInjectedAt = null;
    this.startedAt = Date.now();
  }

  async source() {
    if (!this.injectionSource) this.injectionSource = await readFile(INJECTION_PATH, "utf8");
    return this.injectionSource;
  }

  async updateSettings(settings, options = {}) {
    this.settings = settings;
    if (options.push !== false) await this.injectAll().catch((error) => {
      this.lastError = error.message;
    });
  }

  async tags(endpoint = this.endpoint) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(`${endpoint}/json/list`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Codex 调试端口返回 HTTP ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error("Codex 调试端口返回了无效目标列表");
      return targets.filter(isInjectableTarget).sort((a, b) => scoreTarget(b) - scoreTarget(a));
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("连接 Codex 调试端口超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async discoverAndAttach() {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const targets = await this.tags();
      for (const target of targets) {
        if (this.sessions.has(target.id)) continue;
        const session = new CdpSession(target, this.endpoint, {
          onBinding: (current, payload) => this.handleBinding(current, payload),
          onNavigated: (current) => current.scheduleInject(async () => {
            await current.inject(await this.source(), publicSettings(this.settings));
            this.lastInjectedAt = new Date().toISOString();
          }),
          onClose: (closedTarget) => this.sessions.delete(closedTarget.id),
          onError: (error) => {
            this.lastError = error?.message || String(error);
          },
        });
        try {
          await session.connect();
          this.sessions.set(target.id, session);
          await session.inject(await this.source(), publicSettings(this.settings));
          this.lastInjectedAt = new Date().toISOString();
          this.lastError = "";
        } catch (error) {
          session.close();
          this.lastError = error.message;
        }
      }
    } finally {
      this.discovering = false;
    }
  }

  async attach(endpoint = this.settings.cdpEndpoint) {
    this.endpoint = normalizeCdpEndpoint(endpoint);
    this.stopPolling();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.startPolling();
    await this.discoverAndAttach();
    if (!this.sessions.size) throw new Error(this.lastError || "没有找到可注入的 Codex 页面；请使用启动按钮重新打开带调试端口的 Codex");
    return this.status();
  }

  startPolling() {
    if (this.pollId) return;
    this.pollId = setInterval(() => {
      this.discoverAndAttach().catch((error) => {
        this.lastError = error.message;
      });
    }, DISCOVERY_INTERVAL_MS);
    this.pollId.unref?.();
  }

  stopPolling() {
    if (this.pollId) clearInterval(this.pollId);
    this.pollId = null;
  }

  async injectAll() {
    if (!this.sessions.size) await this.discoverAndAttach();
    const source = await this.source();
    const results = [];
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      try {
        results.push(await session.inject(source, publicSettings(this.settings)));
      } catch (error) {
        this.lastError = error.message;
      }
    }
    if (!results.length) throw new Error(this.lastError || "没有可注入的 Codex 页面");
    this.lastInjectedAt = new Date().toISOString();
    return results;
  }

  detach() {
    this.stopPolling();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    for (const request of this.requests.values()) request.abort.abort();
    this.requests.clear();
    this.lastInjectedAt = null;
  }

  async pushSettingsToPages() {
    const settings = JSON.stringify(publicSettings(this.settings)).replace(/</g, "\\u003c");
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      await session.evaluate(`globalThis.__MAGPIE_CPO_BOOTSTRAP__ = ${settings}; globalThis.__magpieCodexPromptOptimizer?.applyExternalSettings(globalThis.__MAGPIE_CPO_BOOTSTRAP__); true;`).catch(() => {});
    }
  }

  async handleBinding(session, encoded) {
    if (encoded.length > 3 * 1024 * 1024) return;
    let message;
    try {
      message = JSON.parse(encoded);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "optimize") {
      await this.handleOptimization(session, message);
      return;
    }
    if (message.type === "cancel") {
      this.requests.get(String(message.requestId || ""))?.abort.abort();
      return;
    }
    if (message.type === "settings.changed" && message.settings && typeof message.settings === "object") {
      try {
        const { mergeSettings, saveSettings } = await import("./config.js");
        this.settings = mergeSettings(this.settings, message.settings);
        await saveSettings(this.settings);
        await this.onSettingsChanged(this.settings);
      } catch (error) {
        this.lastError = error.message;
      }
      return;
    }
    if (message.type === "diagnose") {
      await this.sendBridgeResult(session, message.requestId, { ok: true, status: 200, text: JSON.stringify(this.status()) });
    }
  }

  async handleOptimization(session, message) {
    const requestId = String(message.requestId || randomUUID());
    const text = String(message.text || "").trim();
    if (!requestId || !text) return;
    if (text.length > 500_000) {
      await this.sendBridgeResult(session, requestId, { ok: false, status: 413, error: "提示词超过 500,000 个字符" });
      return;
    }
    if (this.requests.has(requestId)) return;
    const abort = new AbortController();
    this.requests.set(requestId, { abort, startedAt: Date.now() });
    try {
      const request = buildLlmRequest(this.settings, text);
      const response = await performProxyRequest({
        ...request,
        timeoutMs: 120_000,
        signal: abort.signal,
      });
      const optimized = parseLlmResponse(this.settings.protocol, response.text);
      await this.sendBridgeResult(session, requestId, { ok: true, status: response.status, text: optimized });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      await this.sendBridgeResult(session, requestId, {
        ok: false,
        status: Number(error?.status) || (aborted ? 0 : 502),
        error: aborted ? "请求已取消或超时" : String(error?.message || error).slice(0, 500),
      });
    } finally {
      this.requests.delete(requestId);
    }
  }

  async sendBridgeResult(session, requestId, result) {
    const id = JSON.stringify(String(requestId || ""));
    const payload = JSON.stringify(result).replace(/</g, "\\u003c");
    await session.evaluate(`globalThis.__MAGPIE_CPO_BRIDGE_RECEIVE__?.(${id}, ${payload}); true;`).catch(() => {});
  }

  status() {
    return {
      service: true,
      startedAt: new Date(this.startedAt).toISOString(),
      endpoint: this.endpoint,
      connectedTargets: this.sessions.size,
      injectedTargets: [...this.sessions.values()].filter((session) => session.injected && !session.closed).length,
      targets: [...this.sessions.values()].map((session) => ({ id: session.target.id, url: session.target.url, title: session.target.title, injected: session.injected })),
      activeRequests: this.requests.size,
      lastInjectedAt: this.lastInjectedAt,
      lastError: this.lastError || "",
      settings: {
        protocol: this.settings.protocol,
        baseUrl: this.settings.baseUrl,
        model: this.settings.model,
        style: this.settings.style,
        cdpEndpoint: this.settings.cdpEndpoint,
        hasApiKey: Boolean(this.settings.apiKey),
      },
    };
  }
}

export { delay };
