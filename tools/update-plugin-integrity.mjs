// 构建后自动回填 native 插件的 backend.integrity（sha256:<hex>）。
//
// 为什么必须自动做：dll 重新编译后字节会变，而 manifest 里留着旧 hash 时，
// 宿主加载会以「完整性校验失败」拒载——一键构建看起来成功、插件却静默消失。
//
// 用法：
//   node tools/update-plugin-integrity.mjs           # 全部 kind=native 插件
//   node tools/update-plugin-integrity.mjs notes     # 只处理指定 id
//
// 由 build.cmd / build.sh 在 native 构建步骤之后自动调用。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pluginsRoot = path.join(root, "plugins");
const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));

// 与宿主的选库规则保持一致（ll-plugin-api::native_lib_suffix）
const LIB_SUFFIX = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";

/** 先找后缀匹配且存在的，否则退回第一个存在的——双平台目录各取各的 */
function pickEntry(entries, exists) {
  const list = entries ?? [];
  return list.find((e) => e.toLowerCase().endsWith(LIB_SUFFIX) && exists(e)) ?? list.find(exists) ?? null;
}

function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

let updated = 0;
let unchanged = 0;
let skipped = 0;

for (const dirent of readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  if (only.size > 0 && !only.has(dirent.name)) continue;

  const manifestPath = path.join(pluginsRoot, dirent.name, "manifest.json");
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.warn(`[integrity] ${dirent.name}: manifest.json 解析失败，跳过`);
    skipped += 1;
    continue;
  }
  if (manifest.backend?.kind !== "native") continue;

  if (manifest.backend?.kind !== "native") continue;

  // 目录里实际存在的那个平台产物（dll / so 各取各的）
  const entry = pickEntry(manifest.backend?.entry, (e) =>
    existsSync(path.join(pluginsRoot, dirent.name, e)),
  );
  if (!entry) {
    console.warn(
      `[integrity] ${manifest.id}: 无可用动态库（本平台需要 ${LIB_SUFFIX}），跳过——先编插件再跑本脚本`,
    );
    skipped += 1;
    continue;
  }
  const lib = path.join(pluginsRoot, dirent.name, entry);

  const want = `sha256:${sha256(lib)}`;
  if (manifest.backend.integrity === want) {
    unchanged += 1;
    continue;
  }
  manifest.backend.integrity = want;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[integrity] ${manifest.id}: ${want}`);
  updated += 1;
}

console.log(`[integrity] 完成：更新 ${updated} 个，未变 ${unchanged} 个，跳过 ${skipped} 个`);
