import assert from "node:assert/strict";
import { extractFile, listPackage } from "@electron/asar";
import { builtinModules } from "node:module";
import { join, posix, resolve } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";
import { fileHash, packagingRequire } from "./packaging-tools.mjs";
import { productionBuildCurrent } from "./build-state.mjs";

const { getCurrentFuseWire, FuseV1Options } =
  packagingRequire("@electron/fuses");
const { FuseState } = packagingRequire("@electron/fuses/dist/constants.js");
const expected = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const defaultDirectory =
  process.platform === "darwin"
    ? `release/mac${process.arch === "arm64" ? "-arm64" : ""}/${expected.build.productName}.app`
    : "release/win-unpacked";
const directory = resolve(process.argv[2] || defaultDirectory);
const isMac = directory.endsWith(".app");
const archive = join(
  directory,
  isMac ? "Contents/Resources/app.asar" : "resources/app.asar",
);
const files = new Set(
  listPackage(archive).map((file) =>
    file.replaceAll("\\", "/").replace(/^\//, ""),
  ),
);
const required = (file) => assert.ok(files.has(file), `发行包缺少 ${file}`);
const extract = (file) => {
  required(file);
  return extractFile(archive, join(...file.split("/")));
};
const info = JSON.parse(extract("package.json"));
assert.equal(info.version, expected.version);
assert.equal(info.license, "MIT");
assert.deepEqual(extract("LICENSE"), await readFile(resolve("LICENSE")));
assert.equal(info.main, "out/main/index.js");
assert.ok(
  await productionBuildCurrent(),
  "当前生产构建已过期，不能验收旧发行包",
);

for (const file of files) {
  assert.match(
    file,
    /^(?:out|resources|node_modules)(?:\/|$)|^(?:package\.json|LICENSE)$/,
    `不应打包项目源码、用户数据或临时文件：${file}`,
  );
  if (!file.startsWith("node_modules/")) {
    assert.ok(
      !/(?:^|\/)(?:\.env(?:\.|$)|\.git|state\.json$|config\.toml$|credentials(?:\.|$)|secrets(?:\.|$))/.test(
        file,
      ),
      `不应打包配置或秘密：${file}`,
    );
    assert.ok(
      !/\.(?:moc3|vrm|pmx|pmd|vmd|glb|gltf|key|pem|pfx|p12)$|(?:^|\/)model3?\.json$/i.test(
        file,
      ),
      `不应打包用户模型或私钥：${file}`,
    );
  }
}

let outputFiles = 0;
async function verifyTree(relative) {
  for (const entry of await readdir(resolve(relative), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".")) continue;
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await verifyTree(file);
    else if (entry.isFile()) {
      assert.deepEqual(
        extract(file),
        await readFile(resolve(file)),
        `发行文件与当前构建不一致：${file}`,
      );
      outputFiles++;
    }
  }
}
await verifyTree("out");
await verifyTree("resources");
assert.deepEqual(
  extract("out/.production-build.json"),
  await readFile(resolve("out/.production-build.json")),
  "发行包必须使用最后一次生产构建的指纹",
);
required("out/preload/index.cjs");
for (const icon of ["icon.ico", "icon.png", "tray.png"])
  required(`resources/${icon}`);

const html = extract("out/renderer/index.html").toString();
const policies = [...html.matchAll(/<meta\b[^>]*>/gi)].flatMap(([tag]) => {
  const attributes = new Map(
    [...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [
      match[1].toLowerCase(),
      match[3],
    ]),
  );
  return attributes.get("http-equiv")?.toLowerCase() ===
    "content-security-policy"
    ? [attributes.get("content") || ""]
    : [];
});
assert.ok(policies.length > 0, "正式页面必须提供 CSP");
for (const policy of policies) {
  assert.match(policy, /(?:^|;)\s*connect-src\s/i, "正式 CSP 必须限制连接来源");
  assert.doesNotMatch(
    policy,
    /\bwss?:|https?:\/\/(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})(?=[:/\s;]|$)/i,
    "正式 CSP 不得保留开发 WebSocket 或 loopback HTTP 端点授权",
  );
}
const references = [
  ...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g),
].map((match) => match[1]);
assert.ok(references.some((file) => file.endsWith(".js")));
assert.ok(references.some((file) => file.endsWith(".css")));
for (const reference of references) {
  assert.ok(
    !/^(?:[a-z]+:|\/)/i.test(reference),
    `正式页面引用必须为包内相对路径：${reference}`,
  );
  const file = posix.normalize(
    posix.join("out/renderer", decodeURIComponent(reference.split(/[?#]/)[0])),
  );
  assert.ok(
    file.startsWith("out/renderer/"),
    `页面引用不能离开 renderer：${reference}`,
  );
  required(file);
}

const main = extract("out/main/index.js").toString();
const source = ts.createSourceFile(
  "index.js",
  main,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const dependencies = source.statements
  .filter(ts.isImportDeclaration)
  .map((node) => node.moduleSpecifier.text)
  .filter(
    (name) =>
      name !== "electron" &&
      !name.startsWith("node:") &&
      !builtinModules.includes(name) &&
      !name.startsWith("."),
  );
assert.ok(dependencies.includes("ws") && dependencies.includes("zod"));
for (const name of new Set(dependencies)) {
  const packageName = name.startsWith("@")
    ? name.split("/").slice(0, 2).join("/")
    : name.split("/")[0];
  assert.ok(info.dependencies[packageName], `主进程依赖未声明：${packageName}`);
  const root = `node_modules/${packageName}`;
  const dependency = JSON.parse(extract(`${root}/package.json`));
  const entry = dependency.exports?.["."];
  for (const target of [
    dependency.main || "index.js",
    dependency.module,
    typeof entry === "string" ? entry : entry?.import,
    entry?.require,
  ].filter(Boolean))
    if (typeof target === "string") required(posix.join(root, target));
}
const guard = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "developmentRendererUrl",
);
assert.ok(guard, "正式入口缺少 renderer 来源校验");
const rendererSource = new Script(`(${guard.getText(source)})`).runInNewContext(
  { URL },
);
assert.equal(rendererSource(true, "not a URL"), undefined);
assert.equal(rendererSource(true, "http://127.0.0.1:9/"), undefined);
assert.equal(
  rendererSource(false, "http://127.0.0.1:5173/"),
  "http://127.0.0.1:5173",
);
assert.throws(() => rendererSource(false, "https://remote.invalid/"));
assert.ok(
  /developmentRendererUrl\(\s*app\.isPackaged\s*,\s*process\.env\.ELECTRON_RENDERER_URL/s.test(
    main,
  ),
  "正式入口必须根据 app.isPackaged 选择页面来源",
);
for (const scheme of ["mai-asset", "mai-media"])
  assert.ok(
    new RegExp(`protocol\\.handle\\(\\s*["']${scheme}["']`).test(main),
    `缺少 ${scheme} 协议注册`,
  );

const executable = join(
  directory,
  isMac
    ? `Contents/MacOS/${expected.build.productName}`
    : `${expected.build.productName}.exe`,
);
const wire = await getCurrentFuseWire(executable);
assert.equal(
  wire[FuseV1Options.RunAsNode],
  FuseState.DISABLE,
  "正式应用必须关闭 RunAsNode fuse",
);
if (isMac) {
  const { parse } = packagingRequire("plist");
  const plist = parse(
    await readFile(join(directory, "Contents/Info.plist"), "utf8"),
  );
  assert.equal(plist.CFBundleIdentifier, expected.build.appId);
  assert.equal(plist.CFBundleShortVersionString, expected.version);
  assert.equal(plist.CFBundleExecutable, expected.build.productName);
  assert.equal(
    plist.NSMicrophoneUsageDescription,
    expected.build.mac.extendInfo.NSMicrophoneUsageDescription,
  );
  assert.equal(
    plist.NSCameraUsageDescription,
    expected.build.mac.extendInfo.NSCameraUsageDescription,
  );
  assert.ok(plist.CFBundleIconFile, "Mac 图标资源缺失");
  const icon = await readFile(
    join(directory, "Contents/Resources", plist.CFBundleIconFile),
  );
  assert.equal(icon.toString("ascii", 0, 4), "icns");
  const binary = await readFile(executable);
  assert.equal(
    binary.readUInt32LE(0),
    0xfeedfacf,
    "必须是原生 64 位 Mach-O 程序",
  );
  assert.equal(
    binary.readUInt32LE(4),
    process.arch === "arm64" ? 0x0100000c : 0x01000007,
    "Mac 包架构必须与构建主机一致",
  );
} else {
  const { NtExecutable, NtExecutableResource, Resource } =
    packagingRequire("resedit");
  const pe = NtExecutable.from(await readFile(executable));
  const resources = NtExecutableResource.from(pe);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  const strings = versions.flatMap((version) =>
    version
      .getAllLanguagesForStringValues()
      .map((language) => version.getStringValues(language)),
  );
  assert.ok(
    strings.some(
      (value) =>
        value.ProductName === expected.build.productName &&
        value.FileVersion === expected.version,
    ),
    "EXE 产品名称或版本资源不正确",
  );
  assert.ok(
    Resource.IconGroupEntry.fromEntries(resources.entries).length > 0,
    "EXE 图标资源缺失",
  );
}
const report = {
  passed: true,
  version: expected.version,
  directory,
  checkedOutputFiles: outputFiles,
  htmlReferences: references,
  productionCsp: policies,
  developmentWebSocketAccess: false,
  mainDependencies: [...new Set(dependencies)],
  runAsNode: false,
  rendererSourceGuard: true,
  asarSha256: await fileHash(archive),
  executableSha256: await fileHash(executable),
};
await mkdir(resolve(".cache/release-verification"), { recursive: true });
await writeFile(
  resolve(".cache/release-verification/result.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  `PASS 正式包 v${expected.version}：ASAR ${outputFiles} 个构建/资源文件、HTML 引用、主进程依赖、图标/版本、RunAsNode 关闭与 renderer 来源保护`,
);
