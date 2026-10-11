// 安装外部插件：把 plugins/<id> 拷贝到宿主扫描目录，拷入即安装。
// 用法：
//   npm run plugin:install -- sysinfo             → 用户安装目录 extplugins/（同名优先）
//   npm run plugin:install -- sysinfo --portable  → 便携目录 release/plugins/（随程序分发）
// 卸载：直接删除对应目录。宿主加载顺序：extplugins > 便携目录（同名取前者）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const id = process.argv[2];
if (!id) {
  console.error("用法: npm run plugin:install -- <插件目录名，如 sysinfo>");
  process.exit(1);
}

const src = path.resolve("plugins", id);
const manifestPath = path.join(src, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`未找到 ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.backend?.kind !== "llp") {
  console.error(`插件 ${id} 不是外部插件（backend.kind != "llp"），无需安装（编译期内置）`);
  process.exit(1);
}

const portable = process.argv.includes("--portable");
let dest;
if (portable) {
  // 便携模式：主程序旁 plugins/（本仓库布局为 release/plugins，随 release/ 一起分发）
  dest = path.resolve("release", "plugins", id);
} else {
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
  dest = path.join(dataHome, "LiteLauncher", "extplugins", id);
}

mkdirSync(path.dirname(dest), { recursive: true });
rmSync(dest, { recursive: true, force: true }); // 重装 = 覆盖
cpSync(src, dest, { recursive: true });
console.log(`[install] ${id}@${manifest.version} → ${dest}${portable ? "（便携，随程序分发）" : "（用户安装）"}`);
console.log("[install] 重启 LiteLauncher 后生效；设置面板可启用/禁用");
