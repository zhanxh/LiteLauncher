#!/usr/bin/env node
/**
 * 生成 Tauri updater 的 latest.json。
 *
 * 用法（CI）：
 *   node tools/make-latest-json.mjs --repo owner/name --version 0.2.0 \
 *     --bundle-dir src-tauri/target-ship/release/bundle/nsis \
 *     --out latest.json
 *
 * Tauri 在 createUpdaterArtifacts 打开时会产出 `<installer>.nsis.zip` 与 `.sig`；
 * latest.json 的 url 必须指向 zip，签名取 .sig 全文。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const repo = argOf('repo') || process.env.GITHUB_REPOSITORY;
const version = argOf('version') || process.env.GITHUB_REF_NAME?.replace(/^v/, '');
const bundleDir = resolve(argOf('bundle-dir') || 'src-tauri/target-ship/release/bundle/nsis');
const out = resolve(argOf('out') || 'latest.json');
const notes = argOf('notes') || 'See CHANGELOG.md';

if (!repo || !version) {
  console.error('缺少 --repo owner/name 或 --version');
  process.exit(1);
}
if (!existsSync(bundleDir)) {
  console.error(`bundle 目录不存在: ${bundleDir}`);
  process.exit(1);
}

const files = readdirSync(bundleDir);
const zip = files.find((f) => f.endsWith('.nsis.zip'));
if (!zip) {
  console.error(`没有找到 *.nsis.zip（Tauri updater artifact）: ${bundleDir}`);
  process.exit(1);
}
const sig = files.find((f) => f === `${zip}.sig`);
if (!sig) {
  console.error(`没有找到 ${zip}.sig，检查 TAURI_SIGNING_PRIVATE_KEY 是否配置`);
  process.exit(1);
}

const tag = `v${version}`;
const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(zip)}`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(bundleDir, sig), 'utf8').trim(),
      url: downloadUrl,
    },
  },
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[latest-json] ${version} → ${zip}`);
console.log(`[latest-json] ${downloadUrl}`);
