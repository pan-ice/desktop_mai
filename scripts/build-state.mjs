import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { projectRoot } from "./process-tools.mjs";

const inputs = [
  "electron",
  "shared",
  "src",
  "resources",
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "electron.vite.config.ts",
  "dev-csp.ts",
  "dev-server.ts",
  "vite.config.ts",
];
const entries = [
  "out/main/index.js",
  "out/preload/index.cjs",
  "out/renderer/index.html",
];
const manifest = "out/.production-build.json";

async function digest(root, paths) {
  const hash = createHash("sha256");
  const visit = async (file) => {
    try {
      const children = await readdir(file, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name)))
        if (
          !child.isSymbolicLink() &&
          join(file, child.name) !== join(root, manifest)
        )
          await visit(join(file, child.name));
    } catch (error) {
      if (error.code === "ENOENT") {
        hash.update(`missing:${relative(root, file)}\0`);
        return;
      }
      if (error.code !== "ENOTDIR") throw error;
      const content = await readFile(file);
      hash.update(relative(root, file).replaceAll("\\", "/")).update("\0");
      hash.update(String(content.length)).update("\0").update(content);
    }
  };
  for (const path of paths) await visit(join(root, path));
  return hash.digest("hex");
}

export const sourceDigest = (root = projectRoot) => digest(root, inputs);

export async function productionBuildCurrent(root = projectRoot) {
  try {
    for (const path of entries) await readFile(join(root, path));
    const saved = JSON.parse(await readFile(join(root, manifest), "utf8"));
    return (
      saved.version === 1 &&
      saved.source === (await sourceDigest(root)) &&
      saved.output === (await digest(root, ["out"]))
    );
  } catch {
    return false;
  }
}

export async function recordProductionBuild(root = projectRoot, before) {
  for (const path of entries) await readFile(join(root, path));
  const source = await sourceDigest(root);
  if (before && source !== before)
    throw new Error("构建期间源码发生变化，请重新运行 npm run build");
  await writeFile(
    join(root, manifest),
    JSON.stringify(
      { version: 1, source, output: await digest(root, ["out"]) },
      null,
      2,
    ),
  );
}
