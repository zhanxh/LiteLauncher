#!/usr/bin/env node
/**
 * 版本号单一真相源：`package.json.version` 是唯一输入。
 *
 * 为什么需要：版本号此前散落在 `package.json`、`src-tauri/tauri.conf.json`
 * 与 README 标题三处，已经出现过 `0.1.0` 与 `v3.0` 并存的情况。发版前手改
 * 两个文件迟早会漏，CI 也拦不住。这里把"写"和"校验"收成一个脚本：
 *
 *   node tools/sync-version.mjs          # 把 package.json 的版本写入 tauri.conf.json
 *   node tools/sync-version.mjs --check  # 只校验，不一致时退出码 1（CI 用）
 *
 * README 的版本描述由 WP-13 文档重构统一处理，本脚本不碰文案，避免误改正文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const pkg = readJson(pkgPath);
const conf = readJson(confPath);
const expected = String(pkg.version || '').trim();

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error(`[version] package.json 的 version 不是合法 semver: ${JSON.stringify(expected)}`);
  process.exit(1);
}

const actual = String(conf.version || '').trim();
const checkOnly = process.argv.includes('--check');

if (actual === expected) {
  console.log(`[version] 一致: ${expected}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`[version] 不一致: package.json=${expected} tauri.conf.json=${actual}`);
  console.error('[version] 运行 `npm run version:sync` 修正');
  process.exit(1);
}

conf.version = expected;
fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');
console.log(`[version] 已同步 tauri.conf.json: ${actual} -> ${expected}`);
