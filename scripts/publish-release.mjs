import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checkOnly = process.argv.includes("--check");
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--check"),
  "仅支持 --check",
);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const adapter = await readFile("adapter/pyproject.toml", "utf8");
const adapterVersion = adapter.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(adapterVersion, "缺少独立适配器版本");
const tag = `v${version}`;
if (process.env.GITHUB_REF_TYPE === "tag")
  assert.equal(process.env.GITHUB_REF_NAME, tag);
const directory = resolve("release-assets");
const desktop = `Mai-Desktop-Pet-${version}`;
const assets = [
  `${desktop}-win-x64.exe`,
  `${desktop}-mac-x64.dmg`,
  `${desktop}-mac-x64.zip`,
  `${desktop}-mac-arm64.dmg`,
  `${desktop}-mac-arm64.zip`,
  `MaiBot-Desktop-Message-Adapter-${adapterVersion}.zip`,
].sort();
const actual = (await readdir(directory))
  .filter((name) => name !== "SHA256SUMS.txt")
  .sort();
assert.deepEqual(
  actual,
  assets,
  "发行文件必须齐全，且不能混入旧版本或额外文件",
);
const checksums = [];
for (const name of assets) {
  const file = resolve(directory, name);
  const info = await stat(file);
  assert.ok(info.isFile() && info.size > 0, `发行文件为空：${name}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  checksums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(
  resolve(directory, "SHA256SUMS.txt"),
  `${checksums.join("\n")}\n`,
);
console.log(`PASS ${tag}：${assets.length} 个发行文件及 SHA256 校验清单`);
if (checkOnly) process.exit(0);

assert.ok(process.env.GH_REPO, "缺少 GH_REPO");
assert.match(
  process.env.GITHUB_SHA || "",
  /^[a-f0-9]{40}$/,
  "缺少本次构建的提交 SHA",
);
function gh(args, allowFailure = false) {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || `gh ${args[0]} 失败`);
  return result;
}

// A manual run may create a new tag at the exact built commit. Never publish
// freshly built assets against an older tag, or replace a public release.
const tagReference = gh(
  ["api", `repos/${process.env.GH_REPO}/git/ref/tags/${tag}`],
  true,
);
if (tagReference.status === 0) {
  // The refs endpoint returns 404 for a missing tag. The commits endpoint
  // instead returns 422, so only use it to peel a tag known to exist.
  const tagged = gh([
    "api",
    `repos/${process.env.GH_REPO}/commits/${tag}`,
    "--jq",
    ".sha",
  ]);
  assert.equal(
    tagged.stdout.trim(),
    process.env.GITHUB_SHA,
    "版本标签与构建提交不一致",
  );
} else assert.match(tagReference.stderr, /404/, "无法确认远程版本标签");
const existing = gh(["release", "view", tag, "--json", "isDraft"], true);
if (existing.status === 0)
  assert.equal(
    JSON.parse(existing.stdout).isDraft,
    true,
    "该版本已公开发布；请提升版本号后发布新版本",
  );
else
  assert.match(
    existing.stderr,
    /release not found|404/i,
    "无法确认远程 Release 状态",
  );

const notes = `Mai 桌面伙伴 ${tag}，客户端与独立适配器采用 MIT 许可证。

| 系统 | 下载文件 | 使用方式 |
| --- | --- | --- |
| Windows x64 | \`${desktop}-win-x64.exe\` | 便携版，直接运行 |
| Mac Apple Silicon（M 系列） | \`${desktop}-mac-arm64.dmg\` | 打开后拖入 Applications |
| Mac Intel | \`${desktop}-mac-x64.dmg\` | 打开后拖入 Applications |

Mac 同时提供 ZIP，解压后将 .app 移入 Applications。Mac 包使用 ad-hoc 签名，尚无 Apple Developer ID 签名或公证；首次打开如被系统拦截，请在“系统设置 → 隐私与安全性”中允许打开。Windows 包也未使用商业代码签名。

独立适配器为 \`MaiBot-Desktop-Message-Adapter-${adapterVersion}.zip\`，需要 Python 3.11+，配置方法见包内 README。桌宠客户端无需安装 Node.js。内核、模型和 API 凭证由使用者自行配置。

所有下载文件的校验值见 \`SHA256SUMS.txt\`。三个平台均经过单元测试、发行内容核对和实际应用启动、交互与重启验收；Windows 另验收便携启动器。

构建提交：\`${process.env.GITHUB_SHA}\`。
`;
const notesFile = resolve("release-notes.md");
await writeFile(notesFile, notes);
if (existing.status !== 0)
  gh([
    "release",
    "create",
    tag,
    "--target",
    process.env.GITHUB_SHA,
    "--draft",
    "--title",
    `Mai 桌面伙伴 ${tag}`,
    "--notes-file",
    notesFile,
  ]);
else gh(["release", "edit", tag, "--notes-file", notesFile]);
gh([
  "release",
  "upload",
  tag,
  ...[...assets, "SHA256SUMS.txt"].map((name) => resolve(directory, name)),
  "--clobber",
]);
gh(["release", "edit", tag, "--draft=false", "--latest"]);
console.log(
  `已发布：https://github.com/${process.env.GH_REPO}/releases/tag/${tag}`,
);
