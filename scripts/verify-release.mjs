import assert from "node:assert/strict";
import { extractFile, listPackage } from "@electron/asar";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const archive = resolve("release/win-unpacked/resources/app.asar");
const files = listPackage(archive).map((file) => file.replaceAll("\\", "/"));
assert.ok(
  !files.some((file) =>
    /^\/(MaiBot|references|tests|\.cache|\.env)(\/|$)/.test(file),
  ),
);
const info = JSON.parse(extractFile(archive, "package.json"));
const expected = JSON.parse(
  await readFile(resolve("package.json"), "utf8"),
).version;
assert.equal(info.version, expected);
const main = extractFile(archive, join("out", "main", "index.js")).toString();
assert.ok(main.includes("hello") && main.includes("sessionId"));
console.log(
  `PASS ASAR：v${expected}、插件握手与真实会话；排除内核、项目测试与临时数据`,
);
