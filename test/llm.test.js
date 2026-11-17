import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/config.js";
import {
  buildLlmRequest,
  joinApiUrl,
  parseLlmResponse,
  performProxyRequest,
} from "../src/llm.js";

test("OpenAI 与 Anthropic 地址和请求体正确", () => {
  assert.equal(joinApiUrl("https://api.openai.com/v1", "openai"), "https://api.openai.com/v1/chat/completions");
  assert.equal(joinApiUrl("https://api.anthropic.com", "anthropic"), "https://api.anthropic.com/v1/messages");
  const openai = mergeSettings(DEFAULT_SETTINGS, {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-test",
  });
  const openaiRequest = buildLlmRequest(openai, "优化我");
  assert.equal(openaiRequest.headers.authorization, "Bearer sk-test");
  assert.equal(openaiRequest.body.model, "gpt-test");
  assert.equal(openaiRequest.body.stream, true);
  const anthropic = mergeSettings(DEFAULT_SETTINGS, {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant",
    model: "claude-test",
  });
  const anthropicRequest = buildLlmRequest(anthropic, "优化我");
  assert.equal(anthropicRequest.headers["x-api-key"], "sk-ant");
  assert.equal(anthropicRequest.headers["anthropic-version"], "2023-06-01");
  assert.equal(anthropicRequest.body.messages[0].content, "优化我");
});

test("响应解析支持 JSON、SSE、代码围栏并拒绝空内容", () => {
  assert.equal(parseLlmResponse("openai", JSON.stringify({ choices: [{ message: { content: "```text\nhello\n```" } }] })), "hello");
  const stream = [
    'data: {"choices":[{"delta":{"content":"hello "}}]}',
    'data: {"choices":[{"delta":{"content":[{"type":"text","text":"world"}]}}]}',
    "data: [DONE]",
  ].join("\n\n");
  assert.equal(parseLlmResponse("openai", stream), "hello world");
  assert.equal(parseLlmResponse("anthropic", JSON.stringify({ content: [{ type: "text", text: "hello" }] })), "hello");
  assert.throws(() => parseLlmResponse("openai", JSON.stringify({ choices: [] })), /为空/);
  assert.throws(() => parseLlmResponse("openai", "data: [DONE]"), /为空/);
  assert.throws(() => parseLlmResponse("openai", "not-json"), /无法解析/);
});

test("代理请求限制头、禁用重定向并脱敏上游错误", async () => {
  let captured;
  const success = await performProxyRequest({
    url: "https://8.8.8.8/v1/chat/completions",
    method: "POST",
    headers: { authorization: "Bearer sk-test", "x-private": "drop" },
    body: { hello: "world" },
  }, async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(success.ok, true);
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.headers["x-private"], undefined);

  await assert.rejects(() => performProxyRequest({
    url: "https://8.8.8.8/v1/chat/completions",
    headers: { authorization: "Bearer sk-test" },
  }, async () => new Response(JSON.stringify({ error: { message: "invalid token=sk-secret Bearer sk-secret" } }), { status: 401 })), (error) => {
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /sk-secret/);
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test("代理请求拒绝本机 URL 和已取消信号", async () => {
  await assert.rejects(() => performProxyRequest({ url: "https://127.0.0.1/v1" }, async () => new Response("")), /本机|保留地址/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => performProxyRequest({
    url: "https://8.8.8.8/v1/chat/completions",
    signal: controller.signal,
  }, async () => new Response("")), (error) => error.name === "AbortError");
});
