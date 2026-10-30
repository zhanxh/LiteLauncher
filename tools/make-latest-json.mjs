#!/usr/bin/env node
/**
 * 生成 Tauri updater 的 latest.json。
 *
 * 用法（CI）：
 *   node tools/make-latest-json.mjs --repo owner/name --version 0.2.0 \
 *     --bundle-dir src-tauri/target-ship/release/bundle/nsis \
 *     --out latest.json
 *
 * Tauri v2 的 `createUpdaterArtifacts: true` 直接复用安装包本体作为更新载体：
 * Windows 下产出 `<installer>.exe` 与同名 `.sig`（旧的 `<installer>.nsis.zip` 只在
 * `createUpdaterArtifacts: "v1Compatible"` 下生成，该选项将在 v3 移除）。
 * latest.json 的 url 必须指向被签名的那个文件，签名取对应 `.sig` 全文。
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
const signed = files.filter(
  (f) => (f.endsWith('.nsis.zip') || f.endsWith('.exe')) && files.includes(`${f}.sig`),
);
if (signed.length === 0) {
  console.error(
    `没有找到带同名 .sig 的 updater artifact（*.nsis.zip 或 *-setup.exe）: ${bundleDir}\n` +
      `目录内容: ${files.join(', ') || '(空)'}`,
  );
  console.error('若只有 .exe 没有 .sig，检查 TAURI_SIGNING_PRIVATE_KEY 是否配置');
  process.exit(1);
}
const artifact = signed.find((f) => f.endsWith('.nsis.zip')) ?? signed.find((f) => f.endsWith('.exe'));
const sig = `${artifact}.sig`;

const tag = `v${version}`;
const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(artifact)}`;
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
console.log(`[latest-json] ${version} → ${artifact}`);
console.log(`[latest-json] ${downloadUrl}`);
