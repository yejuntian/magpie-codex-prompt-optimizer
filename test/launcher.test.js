import assert from "node:assert/strict";
import test from "node:test";
import { codexLaunchEnvironment } from "../src/launcher.js";

test("Codex 启动环境持久包含本机调试端口和原用户数据目录", () => {
  const environment = codexLaunchEnvironment("http://127.0.0.1:9333");
  const switches = JSON.parse(environment.CODEX_ELECTRON_CHROMIUM_SWITCHES);

  assert.equal(environment.BUILD_FLAVOR, "dev");
  assert.equal(environment.CODEX_ELECTRON_USER_DATA_PATH, `${process.env.HOME}/Library/Application Support/Codex`);
  assert.equal(switches["remote-debugging-address"], "127.0.0.1");
  assert.equal(switches["remote-debugging-port"], "9333");
  assert.throws(() => codexLaunchEnvironment("http://127.0.0.1"), /端口/);
});
