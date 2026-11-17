import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/config.js";
import { startServer, stopServer } from "../src/server.js";

test("本地服务鉴权、设置脱敏和配置校验", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-cpo-server-"));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify(mergeSettings(DEFAULT_SETTINGS, { autoAttach: false }), null, 2)}\n`);
  const app = await startServer({ port: 0, configPath });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp(app.uiToken));
    assert.doesNotMatch(page.headers.get("content-security-policy") || "", /frame-ancestors/);

    const csp = page.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /http:\/\/127\.0\.0\.1/);

    const preflight = await fetch(`${base}/api/status`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "GET" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "null");

    const denied = await fetch(`${base}/api/status`);
    assert.equal(denied.status, 403);

    const status = await fetch(`${base}/api/status`, {
      headers: { "x-magpie-cpo-token": app.uiToken, origin: "null" },
    });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("access-control-allow-origin"), "null");
    const statusBody = await status.json();
    assert.equal(statusBody.status.service, true);
    assert.equal(Object.hasOwn(statusBody.settings, "apiKey"), false);

    const invalid = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-cpo-token": app.uiToken },
      body: JSON.stringify({ baseUrl: "http://api.openai.com/v1" }),
    });
    assert.equal(invalid.status, 400);

    const saved = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-cpo-token": app.uiToken },
      body: JSON.stringify({ baseUrl: "https://8.8.8.8/v1", apiKey: "sk-server-secret", model: "test-model" }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.settings.hasApiKey, true);
    assert.equal(Object.hasOwn(savedBody.settings, "apiKey"), false);

    const cleared = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-cpo-token": app.uiToken },
      body: JSON.stringify({ clearApiKey: true }),
    });
    const clearedBody = await cleared.json();
    assert.equal(clearedBody.settings.hasApiKey, false);
  } finally {
    await stopServer(app);
  }
});
