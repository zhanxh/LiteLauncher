/**
 * 裸文本搜索提供者注册表（LPS-1 SearchProvider 扩展点）
 *
 * 壳层聚合规则（R1 按键扇出预算）：
 * - provider 按 priority 升序并行执行（Promise.allSettled，不串行等最慢者）
 * - 每轮查询带序号做陈旧结果取消
 * - 聚合层外加 50ms debounce（在壳层触发处实现）
 */
import { SearchProvider } from './command';

class SearchRegistry {
  private providers = new Map<string, SearchProvider>();

  register(provider: SearchProvider): void {
    this.providers.set(provider.id, provider);
  }

  getById(id: string): SearchProvider | undefined {
    return this.providers.get(id);
  }

  /** 按 priority 升序的全部提供者 */
  getAll(): SearchProvider[] {
    return [...this.providers.values()].sort((a, b) => a.priority - b.priority);
  }
}

export const searchRegistry = new SearchRegistry();
