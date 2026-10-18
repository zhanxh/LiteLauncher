/**
 * 自动更新：检查、下载安装、重启。
 *
 * 更新源与签名公钥在 `src-tauri/tauri.conf.json` 的 `plugins.updater` 里；
 * CI 发布时用 `tools/release-config.mjs` 把 OWNER/REPO 换成真实仓库。
 * 未配置公钥时 `check()` 会抛错——这里翻译成"更新源未配置"，不吓用户。
 */
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
}

export interface UpdateCheckResult {
  available: boolean;
  info?: UpdateInfo;
  error?: string;
}

let pending: Update | null = null;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();
  if (/public key|pubkey|signature|签名|公钥/.test(lower)) {
    return '更新源未配置：维护者需要配置签名公钥后才能启用自动更新';
  }
  if (/404|not found|endpoint|network|timeout|fetch|dns|连接/.test(lower)) {
    return '更新源不可达，检查网络或发布地址后重试';
  }
  return `检查更新失败：${raw || '未知错误'}`;
}

/** 检查更新；同一时间只保留一个 Update 资源，重复检查会先关旧的 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { available: false, error: '仅桌面版支持自动更新' };
  if (pending) {
    await pending.close().catch(() => undefined);
    pending = null;
  }
  try {
    const update = await check({ timeout: 15_000 });
    if (!update) return { available: false };
    pending = update;
    return {
      available: true,
      info: {
        version: update.version,
        currentVersion: update.currentVersion,
        body: update.body,
      },
    };
  } catch (err) {
    return { available: false, error: explain(err) };
  }
}

/**
 * 下载并安装已检查到的更新。
 *
 * Windows 上安装器启动后应用会退出；macOS/Linux 需要 relaunch()。
 * `onProgress` 只用于设置页展示，不参与安装决策。
 */
export async function installPendingUpdate(
  onProgress?: (text: string) => void,
): Promise<void> {
  if (!pending) throw new Error('没有待安装的更新，请先检查更新');
  let downloaded = 0;
  let total = 0;
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
        onProgress?.(total > 0 ? `正在下载 0%` : '正在下载…');
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        onProgress?.(total > 0 ? `正在下载 ${pct}%` : `已下载 ${Math.round(downloaded / 1024)} KB`);
      } else if (event.event === 'Finished') {
        onProgress?.('下载完成，正在安装…');
      }
    });
    onProgress?.('安装完成，正在重启…');
    await relaunch();
  } catch (err) {
    throw new Error(explain(err));
  } finally {
    pending = null;
  }
}
