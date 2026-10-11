// 部署外部插件（LLP）到便携目录 release/plugins/，使 release/ 构成完整可分发包：
//   LiteLauncher(.exe) + release/plugins/<id>/
// 仅拷贝 manifest 中 backend.kind === "llp" 的插件；编译期内置插件无部署物。
// 由 build.sh / build.cmd 在构建末尾自动调用，也可手动执行：
//   node tools/deploy-portable-plugins.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const srcRoot = path.join(root, "plugins");
const destRoot = path.join(root, "release", "plugins");

if (!existsSync(srcRoot)) {
  console.error("[deploy-plugins] 未找到 plugins/ 目录");
  process.exit(1);
}
mkdirSync(destRoot, { recursive: true });

let deployed = 0;
for (const dirent of readdirSync(srcRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const manifestPath = path.join(srcRoot, dirent.name, "manifest.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.backend?.kind !== "llp") continue; // 编译期内置插件：无部署物

  const dest = path.join(destRoot, dirent.name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(path.join(srcRoot, dirent.name), dest, { recursive: true });
  console.log(`[deploy-plugins] ${manifest.id}@${manifest.version} → ${path.relative(root, dest)}`);
  deployed += 1;
}

console.log(`[deploy-plugins] 完成：${deployed} 个外部插件已部署到 release/plugins/`);
