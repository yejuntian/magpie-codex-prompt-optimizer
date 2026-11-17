import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PageService } from "../index.js";

test("Magpie host 暴露 PageService 并声明本机服务端口", async () => {
  assert.equal(typeof PageService, "function");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.main, "index.js");
  assert.equal(packageJson.magpie.page.file, "page/index.html");
  assert.deepEqual(packageJson.magpie.page.service, { port: 47821, option: "servicePort" });
});
