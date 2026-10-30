#!/usr/bin/env node
/**
 * 生成单个平台的 Tauri updater 清单片段（latest.json 的一部分）。
 *
 * 用法（CI）：
 *   node tools/make-latest-json.mjs --platform windows-x86_64 --out latest-windows.json
 *   node tools/make-latest-json.mjs --platform linux-x86_64   --out latest-linux.json
 * 多个平台的片段用 tools/merge-latest-json.mjs 合成最终 latest.json。
 *
 * Tauri v2 的 `createUpdaterArtifacts: true` 直接复用安装包本体作为更新载体，
 * 每个平台被签名的文件不一样，url 必须指向那个被签名的文件、签名取同名 `.sig` 全文：
 *   Windows → `<installer>-setup.exe`（旧的 `<installer>.nsis.zip` 只在
 *             `createUpdaterArtifacts: "v1Compatible"` 下生成，v3 会移除）
 *   Linux   → `<AppImage>`（v2 也只签 AppImage 本体，不产 v1 时代的 `.AppImage.tar.gz`；
 *             updater 客户端 `install_appimage` 两种都收——payload 是 gzip 就解 tar，
 *             是 ELF 就直接覆写当前 AppImage——但 deb/rpm 装的客户端按 bundle type
 *             走 install_deb/install_rpm，收到 ELF payload 会报 InvalidUpdaterFormat）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// pick 挑出该平台的 updater 载体；顺序即优先级（新形状放前面）。
const PLATFORMS = {
  'windows-x86_64': {
    bundleDir: 'src-tauri/target-ship/release/bundle/nsis',
    carriers: [{ suffix: '.nsis.zip' }, { suffix: '.exe' }],
  },
  'linux-x86_64': {
    bundleDir: 'src-tauri/target-ship/release/bundle/appimage',
    carriers: [{ suffix: '.AppImage' }],
  },
};

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const platform = argOf('platform');
const conf = PLATFORMS[platform];
if (!conf) {
  console.error(`未知平台: ${platform}（可选 ${Object.keys(PLATFORMS).join(' | ')}）`);
  process.exit(1);
}

const repo = argOf('repo') || process.env.GITHUB_REPOSITORY;
const version = argOf('version') || process.env.GITHUB_REF_NAME?.replace(/^v/, '');
const bundleDir = resolve(argOf('bundle-dir') || conf.bundleDir);
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
  (f) => conf.carriers.some(({ suffix }) => f.endsWith(suffix)) && files.includes(`${f}.sig`),
);
if (signed.length === 0) {
  console.error(
    `没有找到带同名 .sig 的 ${platform} updater artifact（${conf.carriers
      .map(({ suffix }) => `*${suffix}`)
      .join(' 或 ')}）: ${bundleDir}\n目录内容: ${files.join(', ') || '(空)'}`,
  );
  console.error('若只有安装包没有 .sig，检查 TAURI_SIGNING_PRIVATE_KEY 是否配置');
  process.exit(1);
}
const artifact = conf.carriers
  .map(({ suffix }) => signed.find((f) => f.endsWith(suffix)))
  .find(Boolean);
const sig = `${artifact}.sig`;

const tag = `v${version}`;
const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(artifact)}`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: {
      signature: readFileSync(join(bundleDir, sig), 'utf8').trim(),
      url: downloadUrl,
    },
  },
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[latest-json] ${platform} ${version} → ${artifact}`);
console.log(`[latest-json] ${downloadUrl}`);
