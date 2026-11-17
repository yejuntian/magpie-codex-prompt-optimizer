import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { publicSettings, loadSettings, mergeSettings, saveSettings } from "./config.js";
import { PromptOptimizerController } from "./controller.js";
import { launchCodexWithCdp } from "./launcher.js";

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const UI_TOKEN_HEADER = "x-magpie-cpo-token";
const UI_TOKEN_PLACEHOLDER = "__MAGPIE_CPO_UI_TOKEN__";
const PAGE_DIR = new URL("../page/", import.meta.url);

function accessControlHeaders(request) {
  const origin = request.headers.origin;
  return origin === "null"
    ? {
        "access-control-allow-origin": "null",
        "access-control-allow-headers": `content-type, ${UI_TOKEN_HEADER}`,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "Origin",
      }
    : {};
}

function writeJson(request, response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...accessControlHeaders(request),
  });
  response.end(body);
}

function writeText(request, response, status, type, body) {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...accessControlHeaders(request),
  });
  response.end(body);
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    throw new Error("请求必须使用 application/json");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("请求体超过 3 MB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
  return parsed;
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createApplication(options = {}) {
  const loaded = await loadSettings(options.configPath);
  const forcedPort = Number(options.port ?? process.env.CPO_PORT ?? loaded.servicePort);
  let settings = mergeSettings(loaded, { servicePort: forcedPort }, { forcePort: forcedPort });
  const controller = new PromptOptimizerController(settings, {
    configPath: options.configPath,
    onSettingsChanged: async (next) => {
      settings = next;
    },
  });
  return {
    server: null,
    port: forcedPort,
    host: options.host || "127.0.0.1",
    controller,
    settings,
    uiToken: randomBytes(32).toString("hex"),
  };
}

export async function startServer(options = {}) {
  const app = await createApplication(options);
  const pageFiles = await Promise.all([
    readFile(new URL("app.html", PAGE_DIR), "utf8"),
    readFile(new URL("app.js", PAGE_DIR), "utf8"),
    readFile(new URL("style.css", PAGE_DIR), "utf8"),
    readFile(new URL("icon.svg", PAGE_DIR), "utf8"),
  ]);
  const [appHtml, appJs, styleCss, iconSvg] = pageFiles;

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      if (origin !== "null") {
        writeJson(request, response, 403, { ok: false, error: "不允许该来源访问本机桥接服务" });
        return;
      }
      response.writeHead(204, accessControlHeaders(request));
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const html = appHtml.replace(UI_TOKEN_PLACEHOLDER, app.uiToken);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(html);
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        writeText(request, response, 200, "text/javascript; charset=utf-8", appJs);
        return;
      }
      if (request.method === "GET" && url.pathname === "/style.css") {
        writeText(request, response, 200, "text/css; charset=utf-8", styleCss);
        return;
      }
      if (request.method === "GET" && url.pathname === "/icon.svg") {
        writeText(request, response, 200, "image/svg+xml; charset=utf-8", iconSvg);
        return;
      }

      if (url.pathname.startsWith("/api/") && !tokenMatches(request.headers[UI_TOKEN_HEADER], app.uiToken)) {
        writeJson(request, response, 403, { ok: false, error: "本地桥接会话无效；请重新打开 Magpie 插件页" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        writeJson(request, response, 200, { ok: true, status: app.controller.status(), settings: publicSettings(app.settings) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        writeJson(request, response, 200, publicSettings(app.settings));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const patch = await readJson(request);
        const next = mergeSettings(app.settings, patch, { forcePort: app.port });
        await saveSettings(next, options.configPath);
        app.settings = next;
        await app.controller.updateSettings(next, { push: false });
        if (next.autoAttach && app.controller.sessions.size) await app.controller.pushSettingsToPages();
        writeJson(request, response, 200, { ok: true, settings: publicSettings(next), status: app.controller.status() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/attach") {
        const body = await readJson(request);
        const endpoint = body.endpoint || app.settings.cdpEndpoint;
        const next = mergeSettings(app.settings, { cdpEndpoint: endpoint }, { forcePort: app.port });
        await saveSettings(next, options.configPath);
        app.settings = next;
        await app.controller.updateSettings(next, { push: false });
        const status = await app.controller.attach(next.cdpEndpoint);
        writeJson(request, response, 200, { ok: true, status });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/inject") {
        await app.controller.updateSettings(app.settings, { push: false });
        const targets = await app.controller.injectAll();
        writeJson(request, response, 200, { ok: true, targets, status: app.controller.status() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/detach") {
        app.controller.detach();
        writeJson(request, response, 200, { ok: true, status: app.controller.status() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/launch") {
        const body = await readJson(request);
        const endpoint = body.endpoint || app.settings.cdpEndpoint;
        const next = mergeSettings(app.settings, { cdpEndpoint: endpoint }, { forcePort: app.port });
        await saveSettings(next, options.configPath);
        app.settings = next;
        await app.controller.updateSettings(next, { push: false });
        const launched = await launchCodexWithCdp(next.cdpEndpoint);
        const status = await app.controller.attach(next.cdpEndpoint);
        writeJson(request, response, 200, { ok: true, launched, status });
        return;
      }
      writeJson(request, response, 404, { ok: false, error: "未找到接口" });
    } catch (error) {
      writeJson(request, response, 400, { ok: false, error: String(error?.message || error).slice(0, 800) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(app.port, app.host, resolve);
  });
  const address = server.address();
  if (address && typeof address === "object") app.port = address.port;
  app.server = server;
  if (app.settings.autoAttach) controllerAttachSoon(app);
  return app;
}

function controllerAttachSoon(app) {
  const timer = setTimeout(async () => {
    try {
      await app.controller.attach(app.settings.cdpEndpoint);
    } catch (error) {
      app.controller.lastError = error.message;
    }
  }, 800);
  timer.unref?.();
}

export async function stopServer(app) {
  if (!app) return;
  app.controller.detach();
  await new Promise((resolve) => app.server?.close?.(resolve) || resolve());
}
