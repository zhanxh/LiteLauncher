#!/usr/bin/env node
/**
 * 文档相对链接检查。
 *
 * 扫描 AGENT.md、README.md、CHANGELOG.md 与 docs/ 下的 Markdown，逐个校验
 * `[文本](相对路径)` 的目标是否存在。外链（http/https）、锚点、mailto 跳过。
 *
 * 用法：node tools/agent/check-docs.mjs
 * 退出码：0 = 全部可达，1 = 存在死链
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOTS = ["AGENT.md", "README.md", "CHANGELOG.md", "docs"];
const SKIP_DIRS = new Set(["plans", "tasks", "archive", "node_modules", ".git", "images"]);
const SKIP_PREFIX = ["http://", "https://", "mailto:", "tel:", "data:", "skill:", "#", "/"];
const ALLOWLIST = path.join(ROOT, "tools", "agent", "docs-allowlist.json");

function knownExceptions() {
  try {
    const data = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8"));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function walk(target, out = []) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return out;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    if (full.endsWith(".md")) out.push(full);
    return out;
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(target, entry.name), out);
    } else if (entry.name.endsWith(".md")) {
      out.push(path.join(full, entry.name));
    }
  }
  return out;
}

function linksOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const out = [];
  const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    let target = m[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    // 去掉标题："path" "title"
    target = target.replace(/\s+["'][^"']*["']\s*$/, "").trim();
    out.push({ target, line });
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));
const missing = [];
const known = [];
const allow = knownExceptions();
let checked = 0;

for (const file of files) {
  for (const { target, line } of linksOf(file)) {
    if (!target || SKIP_PREFIX.some((p) => target.startsWith(p))) continue;
    const clean = target.split("#")[0].split("?")[0];
    if (!clean) continue;
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* 保留原样 */
    }
    checked += 1;
    const resolved = path.resolve(path.dirname(file), decoded);
    if (fs.existsSync(resolved)) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const hit = allow.find((e) => e.file === rel && e.target === target);
    if (hit) known.push({ file: rel, line, target, reason: hit.reason || "" });
    else missing.push({ file: rel, line, target });
  }
}

console.log(`[docs] 检查 ${files.length} 个文件 / ${checked} 条相对链接`);
if (known.length) {
  console.log(`[docs] ⚠ ${known.length} 条已知例外（不计为失败，见 tools/agent/docs-allowlist.json）：`);
  for (const k of known) console.log(`  ${k.file}:${k.line} -> ${k.target}`);
}
if (!missing.length) {
  console.log("[docs] ✅ 全部可达");
  process.exit(0);
}
console.log(`[docs] ❌ ${missing.length} 条死链：`);
for (const m of missing) console.log(`  ${m.file}:${m.line} -> ${m.target}`);
process.exit(1);
