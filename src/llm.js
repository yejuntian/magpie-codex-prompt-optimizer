import { lookup } from "node:dns/promises";
import net from "node:net";
import { isBlockedHostname } from "./config.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function abortError(message = "aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export async function assertPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("LLM URL 无效");
  }
  if (url.protocol !== "https:") throw new Error("LLM URL 必须使用 HTTPS");
  if (url.username || url.password) throw new Error("LLM URL 不能包含凭据");
  if (isBlockedHostname(url.hostname)) throw new Error("LLM URL 不能指向本机、链路本地或保留地址");
  if (!net.isIP(url.hostname)) {
    let addresses;
    try {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("无法解析 LLM 主机");
    }
    if (!addresses.length || addresses.some(({ address }) => isBlockedHostname(address))) {
      throw new Error("LLM 主机解析到了本机、链路本地或保留地址");
    }
  }
  return url;
}

function sanitizeHeaders(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const allowed = new Set([
    "authorization",
    "content-type",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "openai-organization",
    "openai-project",
  ]);
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).toLowerCase();
    if (!allowed.has(key) || typeof rawValue !== "string") continue;
    if (/[\r\n]/.test(rawValue)) throw new Error("请求头包含非法换行");
    if (rawValue.length > 8192) throw new Error("请求头过长");
    out[key] = rawValue;
  }
  return out;
}

async function readLimitedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The local task already has the answer it needs.
      }
      throw new Error("上游响应超过 5 MB");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function errorMessageFromBody(text, fallback) {
  let message = "";
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || parsed?.error || "";
  } catch {
    message = text;
  }
  return String(message || fallback)
    .replace(/Bearer\s+[^\s,;"}]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;"}]+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export async function performProxyRequest(options, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("当前运行时没有 fetch");
  const url = await assertPublicHttpsUrl(options.url);
  const method = String(options.method || "POST").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("只允许 GET 或 POST 请求");
  const body = options.body == null ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  if (body != null && Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("上游请求超过 2 MB");
  const timeoutMs = Math.min(180_000, Math.max(5_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) throw abortError();
    options.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: sanitizeHeaders(options.headers),
      body,
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    const text = await readLimitedText(response);
    if (!response.ok) {
      const message = errorMessageFromBody(text, `HTTP ${response.status}`);
      const error = new Error(message);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return {
      ok: true,
      status: response.status,
      text,
      contentType: response.headers.get("content-type") || "",
    };
  } catch (error) {
    if (timedOut) throw abortError("上游请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", onAbort);
  }
}

export function stripWholeFence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/);
  return match ? match[1].trimEnd() : text;
}

function openAIContentText(raw) {
  return Array.isArray(raw)
    ? raw
        .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
        .map((part) => part.text || "")
        .join("\n")
    : raw;
}

export function extractOpenAIText(payload) {
  const text = openAIContentText(payload?.choices?.[0]?.message?.content);
  if (typeof text !== "string" || !text.trim()) throw new Error("模型返回为空");
  return stripWholeFence(text);
}

export function extractOpenAIStreamText(text) {
  const parts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const raw = choice?.delta?.content ?? choice?.message?.content;
      const content = openAIContentText(raw);
      if (typeof content === "string" && content) parts.push(content);
    }
  }
  const joined = parts.join("");
  if (!joined.trim()) throw new Error("模型返回为空");
  return stripWholeFence(joined);
}

export function extractAnthropicText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("模型返回为空");
  return stripWholeFence(text);
}

export function joinApiUrl(baseUrl, protocol) {
  const url = new URL(baseUrl);
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (protocol === "anthropic") {
    if (/\/v1\/messages$/i.test(path)) return url.href;
    if (/\/messages$/i.test(path)) return url.href;
    if (/\/v1$/i.test(path)) url.pathname = `${path}/messages`;
    else url.pathname = `${path}/v1/messages`.replace(/\/+/g, "/");
  } else if (/\/chat\/completions$/i.test(path)) {
    return url.href;
  } else {
    url.pathname = `${path}/chat/completions`.replace(/\/+/g, "/");
  }
  return url.href;
}

export function buildLlmRequest(settings, userText) {
  const system = settings.systemPrompts?.[settings.style] || settings.systemPrompts?.structured;
  if (!system) throw new Error("缺少 system prompt");
  if (settings.protocol === "anthropic") {
    return {
      url: joinApiUrl(settings.baseUrl, "anthropic"),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: settings.model,
        max_tokens: 4096,
        temperature: 0.3,
        system,
        messages: [{ role: "user", content: userText }],
      },
    };
  }
  return {
    url: joinApiUrl(settings.baseUrl, "openai"),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: {
      model: settings.model,
      temperature: 0.3,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    },
  };
}

export function parseLlmResponse(protocol, text) {
  const raw = String(text || "");
  if (protocol === "openai" && /^data:/m.test(raw)) return extractOpenAIStreamText(raw);
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    throw new Error("模型返回了无法解析的 JSON");
  }
  return protocol === "anthropic" ? extractAnthropicText(payload) : extractOpenAIText(payload);
}
