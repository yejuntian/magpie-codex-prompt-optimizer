import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SYSTEM_PROMPTS,
  isBlockedHostname,
  mergeSettings,
  normalizeBaseUrl,
  normalizeCdpEndpoint,
  publicSettings,
  saveSettings,
} from "../src/config.js";

test("默认提示词要求保留原有 Markdown 与换行", () => {
  for (const prompt of Object.values(DEFAULT_SYSTEM_PROMPTS)) {
    assert.match(prompt, /Preserve the draft's paragraph order, list structure, Markdown, line breaks/);
  }
});

test("设置切换协议时更新默认端点并保留密钥", () => {
  const initial = mergeSettings({}, {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-local-secret",
    model: "custom-openai",
  });
  const switched = mergeSettings(initial, { protocol: "anthropic" });
  assert.equal(switched.baseUrl, "https://api.anthropic.com");
  assert.equal(switched.model, "claude-haiku-4-5-20251001");
  assert.equal(switched.apiKey, "sk-local-secret");
  const cleared = mergeSettings(switched, { clearApiKey: true });
  assert.equal(cleared.apiKey, "");
  const exposed = publicSettings(switched);
  assert.equal(Object.hasOwn(exposed, "apiKey"), false);
  assert.equal(exposed.hasApiKey, true);
});

test("设置拒绝非 HTTPS、本机地址、凭据和非法端口", () => {
  assert.throws(() => normalizeBaseUrl("http://api.openai.com/v1"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://127.0.0.1/v1"), /本机|保留地址/);
  assert.equal(normalizeBaseUrl("https://10.1.2.3/v1"), "https://10.1.2.3/v1");
  assert.throws(() => normalizeBaseUrl("https://user:pass@api.openai.com/v1"), /用户名或密码/);
  assert.throws(() => mergeSettings({}, { servicePort: 80 }), /1024-65535/);
  assert.throws(() => normalizeCdpEndpoint("http://10.0.0.1:9333"), /回环地址/);
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("8.8.8.8"), false);
  assert.equal(isBlockedHostname("10.1.2.3"), false);
});

test("配置文件以 0600 权限保存并可供后续加载", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-cpo-config-"));
  const path = join(dir, "config.json");
  const settings = mergeSettings({}, { apiKey: "sk-file", style: "coding" });
  await saveSettings(settings, path);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.apiKey, "sk-file");
  assert.equal(raw.style, "coding");
});
