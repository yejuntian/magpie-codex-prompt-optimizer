import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

const MAC_APP_CANDIDATES = [
  { appPath: "/Applications/ChatGPT.app", executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
  { appPath: "/Applications/Codex.app", executable: "/Applications/Codex.app/Contents/MacOS/Codex" },
];
let launchInFlight = null;

function run(command, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function existingApp() {
  for (const candidate of MAC_APP_CANDIDATES) {
    try {
      await access(candidate.executable);
      return candidate;
    } catch {
      // Try the next supported app bundle.
    }
  }
  return "";
}

async function waitForCdp(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { cache: "no-store" });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Codex 已启动，但调试端口未就绪：${lastError || "超时"}`);
}

export function codexLaunchEnvironment(endpoint) {
  const port = new URL(endpoint).port;
  if (!port) throw new Error("调试地址缺少端口");
  return {
    BUILD_FLAVOR: "dev",
    CODEX_ELECTRON_USER_DATA_PATH: `${process.env.HOME}/Library/Application Support/Codex`,
    CODEX_ELECTRON_CHROMIUM_SWITCHES: JSON.stringify({
      "remote-debugging-address": "127.0.0.1",
      "remote-debugging-port": port,
      "remote-allow-origins": "*",
    }),
  };
}

export async function persistCodexLaunchEnvironment(endpoint) {
  if (process.platform !== "darwin") return {};
  const launchEnvironment = codexLaunchEnvironment(endpoint);
  for (const [name, value] of Object.entries(launchEnvironment)) {
    const result = await run("launchctl", ["setenv", name, value]);
    if (result.code !== 0) throw new Error(`无法持久化 Codex 启动环境：${name}`);
  }
  return launchEnvironment;
}

export async function launchCodexWithCdp(endpoint) {
  if (process.platform !== "darwin") throw new Error("内置启动器当前只支持 macOS；其他系统请手动给 Codex 添加 --remote-debugging-port");
  if (launchInFlight) return launchInFlight;
  launchInFlight = (async () => {
    const app = await existingApp();
    if (!app) throw new Error("没有找到 /Applications/ChatGPT.app 或 /Applications/Codex.app");
    await persistCodexLaunchEnvironment(endpoint);
    const quit = await run("osascript", ["-e", 'tell application id "com.openai.codex" to quit'], 20_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const open = await run("open", ["-na", app.appPath], 15_000);
    if (open.code !== 0) throw new Error(`无法启动 Codex：${open.stderr.trim() || `退出码 ${open.code}`}`);
    const version = await waitForCdp(endpoint, 25_000);
    return {
      appPath: app.appPath,
      endpoint,
      quitExitCode: quit.code,
      browser: version.Browser || "",
      protocolVersion: version["Protocol-Version"] || "",
      launchEnvironmentPersistent: true,
    };
  })().finally(() => {
    launchInFlight = null;
  });
  return launchInFlight;
}
