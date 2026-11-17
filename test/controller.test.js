import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/config.js";
import { PromptOptimizerController } from "../src/controller.js";

test("推送到 Codex 的设置不含 API Key", async () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, { apiKey: "sk-must-not-leak", cdpEndpoint: "http://127.0.0.1:9333" });
  const controller = new PromptOptimizerController(settings);
  let expression = "";
  controller.sessions.set("target", {
    closed: false,
    injected: true,
    target: { id: "target", url: "app://codex", title: "Codex" },
    evaluate: async (source) => {
      expression = source;
      return {};
    },
  });
  await controller.pushSettingsToPages();
  assert.doesNotMatch(expression, /sk-must-not-leak/);
  assert.match(expression, /"hasApiKey":true/);
  assert.equal(Object.hasOwn(controller.status().settings, "apiKey"), false);
});

test("注入脚本不携带上游认证头", async () => {
  const source = await readFile(new URL("../injected/prompt-optimizer.js", import.meta.url), "utf8");
  assert.match(source, /type: "optimize"/);
  assert.doesNotMatch(source, /authorization/i);
  assert.doesNotMatch(source, /x-api-key/i);
  assert.match(source, /data-field="apiKey" type="password"/);
  assert.match(source, /field\("apiKey"\)\.value = ""/);
});

test("Codex 弹窗保存密钥到本机并只回传脱敏状态", async () => {
  const configPath = join(await mkdtemp(join(tmpdir(), "magpie-cpo-dialog-")), "config.json");
  const controller = new PromptOptimizerController(DEFAULT_SETTINGS, { configPath });
  let reply = "";
  const session = { evaluate: async (expression) => { reply = expression; } };
  await controller.handleBinding(session, JSON.stringify({
    type: "settings.changed",
    requestId: "settings-1",
    settings: { baseUrl: "https://8.8.8.8/v1", model: "test-model", apiKey: "sk-dialog-test" },
  }));
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).apiKey, "sk-dialog-test");
  assert.match(reply, /"hasApiKey":true/);
  assert.doesNotMatch(reply, /sk-dialog-test/);

  await controller.handleBinding(session, JSON.stringify({ type: "settings.changed", requestId: "settings-2", settings: { model: "another-model" } }));
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).apiKey, "sk-dialog-test");

  await controller.handleBinding(session, JSON.stringify({ type: "settings.changed", requestId: "settings-3", settings: { baseUrl: "http://invalid.local" } }));
  assert.match(reply, /"ok":false/);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).baseUrl, "https://8.8.8.8/v1");
});

test("注入脚本使用合法选择器并把取消信号传给桥接请求", async () => {
  const source = await readFile(new URL("../injected/prompt-optimizer.js", import.meta.url), "utf8");
  const owner = source.match(/const OWNER = "([^"]+)";/)?.[1] || "";
  assert.match(owner, /^[a-z][a-z0-9_-]*$/);
  assert.match(source, /const optimized = await optimize\(original, controller\.signal\);/);
  assert.doesNotMatch(source, /optimize\(original, settings, controller\.signal\)/);
});

test("输入卡顿修复不监听页面子树且只低频检查按钮状态", async () => {
  const source = await readFile(new URL("../injected/prompt-optimizer.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /new MutationObserver/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /setInterval\(scheduleRepair, 5000\)/);
  assert.match(source, /inputCheckTimer/);
  assert.match(source, /anchorRect\.left - buttonWidth - 10/);
  assert.match(source, /rowRect\.height - buttonHeight\) \/ 2/);
});

test("优化按钮避开推理模型左侧的上下文用量提示", async () => {
  const source = await readFile(new URL("../injected/prompt-optimizer.js", import.meta.url), "utf8");
  assert.match(source, /function findModelPrefixControl/);
  assert.match(source, /上下文\|context\|token/);
  assert.match(source, /rect\.right <= modelRect\.left \+ 2/);
  assert.match(source, /const anchorRect = prefixRect \|\| modelRect/);
  assert.match(source, /anchorRect\.left - buttonWidth - 10/);
});

test("底栏变窄时检查左侧控件并缩小或隐藏按钮", async () => {
  const source = await readFile(new URL("../injected/prompt-optimizer.js", import.meta.url), "utf8");
  assert.match(source, /const leftControls = Array\.from\(shell\.querySelectorAll/);
  assert.match(source, /preferredLeft < leftBoundary/);
  assert.match(source, /button\.dataset\.compact = "true"/);
  assert.match(source, /host\.style\.display = preferredLeft >= leftBoundary/);
  assert.match(source, /runtime\.resizeObserver\.observe\(element\)/);
  assert.match(source, /runtime\.ensureFrame = 0;[\s\S]*?ensureButton\(\);/);
});

test("首次连接失败后仍保留自动重连轮询", async () => {
  const controller = new PromptOptimizerController(DEFAULT_SETTINGS);
  controller.tags = async () => {
    throw new Error("Codex 暂未启动");
  };
  try {
    await assert.rejects(() => controller.attach("http://127.0.0.1:9333"), /Codex 暂未启动/);
    assert.ok(controller.pollId);
  } finally {
    controller.stopPolling();
  }
});

test("优化请求由本机控制器构造并返回结果", async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (url, init) => {
    upstream = { url: String(url), init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "```text\n优化后的提示词\n```" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      protocol: "openai",
      baseUrl: "https://8.8.8.8/v1",
      apiKey: "sk-host-only",
      model: "test-model",
    });
    const controller = new PromptOptimizerController(settings);
    let expression = "";
    const session = {
      closed: false,
      target: { id: "target", url: "app://codex", title: "Codex" },
      evaluate: async (source) => {
        expression = source;
        return {};
      },
    };
    await controller.handleBinding(session, JSON.stringify({ type: "optimize", requestId: "r1", text: "原始提示词" }));
    assert.equal(upstream.url, "https://8.8.8.8/v1/chat/completions");
    assert.equal(upstream.init.headers.authorization, "Bearer sk-host-only");
    assert.match(String(upstream.init.body), /原始提示词/);
    assert.match(expression, /优化后的提示词/);
    assert.doesNotMatch(expression, /sk-host-only/);
    assert.equal(controller.status().activeRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("取消优化会中止上游请求", async () => {
  const originalFetch = globalThis.fetch;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    markStarted();
    init.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  try {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      baseUrl: "https://8.8.8.8/v1",
      apiKey: "sk-cancel",
      model: "test-model",
    });
    const controller = new PromptOptimizerController(settings);
    let expression = "";
    const session = {
      closed: false,
      target: { id: "target", url: "app://codex", title: "Codex" },
      evaluate: async (source) => {
        expression = source;
        return {};
      },
    };
    const running = controller.handleBinding(session, JSON.stringify({ type: "optimize", requestId: "cancel-me", text: "draft" }));
    await started;
    await controller.handleBinding(session, JSON.stringify({ type: "cancel", requestId: "cancel-me" }));
    await running;
    assert.match(expression, /请求已取消或超时/);
    assert.equal(controller.status().activeRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
