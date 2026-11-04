/**
 * DSH 模型发现：读取 DSH 运行时已注册的模型提供方与模型列表。
 *
 * 契约（与 DSH 0.2.1-rc.2 对齐）：
 *   - ctx.llm.listProviders()  同步返回 [{ id }] ；
 *   - await ctx.llm.listModels(providerId)  返回 [{ provider, id, name }]。
 *
 * 注意：只做只读发现，绝不注册任何 hook / 中间件拦截 DSH 主链路——之前「agent/request」
 * listener 曾经把 DSH 主链路搞崩过，插件只通过 /api/mrrp RPC 通道向控制台暴露模型数据。
 */

/** DSH 模型提供方（最小契约）。 */
export interface LlmProvider {
  id: string;
  name?: string;
  kind?: string;
}

/** DSH 模型（合并 provider 后的扁平表示，供控制台绑定分类用）。 */
export interface LlmModel {
  /** 模型所属提供方 id */
  provider: string;
  /** 模型 id（提供方内唯一） */
  id: string;
  /** 展示名（缺失时回退到 id） */
  name: string;
  /** 模型标识（provider:id），分类绑定与权重映射都用它 */
  key: string;
}

/** host 注入的宽松 DSH 上下文（只取用到的子集，避免对 ctx 强类型依赖）。 */
export interface LlmContext {
  llm?: {
    listProviders?: () => unknown;
    listModels?: (providerId: string) => unknown;
  };
  logger?: (scope: string) => unknown;
}

function asProvider(value: unknown): LlmProvider | null {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, any>).id !== 'string') return null;
  const source = value as Record<string, any>;
  const id = source.id.trim();
  if (!id || id.length > 128) return null;
  return {
    id,
    name: typeof source.name === 'string' ? source.name.trim().slice(0, 128) : undefined,
    kind: typeof source.kind === 'string' ? source.kind.trim().slice(0, 32) : undefined,
  };
}

function asModel(providerId: string, value: unknown): LlmModel | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, any>;
  if (typeof source.id !== 'string') return null;
  const id = source.id.trim();
  if (!id || id.length > 128) return null;
  const provider = (typeof source.provider === 'string' && source.provider.trim())
    ? source.provider.trim().slice(0, 128)
    : providerId;
  const name = (typeof source.name === 'string' && source.name.trim())
    ? source.name.trim().slice(0, 128)
    : id;
  return { provider, id, name, key: `${provider}:${id}` };
}

/** 列出 DSH 当前已发现的所有模型（跨全部提供方）。只读，不抛未知异常。 */
export async function discoverModels(ctx: LlmContext): Promise<LlmModel[]> {
  if (!ctx?.llm || typeof ctx.llm.listProviders !== 'function' || typeof ctx.llm.listModels !== 'function') {
    throw new Error('当前 DSH 运行时不提供模型发现接口（llm.listProviders / llm.listModels）。', { cause: 'llm-unavailable' } as ErrorOptions);
  }
  let providers: LlmProvider[] = [];
  try {
    const raw = ctx.llm.listProviders();
    providers = (Array.isArray(raw) ? raw : []).map(asProvider).filter((p): p is LlmProvider => p !== null);
  } catch (error) {
    throw new Error(`读取模型提供方失败：${(error as Error)?.message ?? error}`, { cause: 'providers-error' } as ErrorOptions);
  }
  const models: LlmModel[] = [];
  for (const provider of providers) {
    try {
      const raw = await ctx.llm.listModels(provider.id);
      const rows = (Array.isArray(raw) ? raw : []).map((row) => asModel(provider.id, row))
        .filter((m): m is LlmModel => m !== null);
      models.push(...rows);
    } catch (error) {
      // 单个提供方失败不影响其它提供方；把错误留给上层决定是否抛出。
      const message = (error as Error)?.message ?? String(error);
      throw new Error(`读取提供方 ${provider.id} 的模型失败：${message}`, { cause: 'models-error' } as ErrorOptions);
    }
  }
  return models;
}

/** 列出提供方（供路由模型配置里的提供方选择）。 */
export function listProviders(ctx: LlmContext): LlmProvider[] {
  if (!ctx?.llm || typeof ctx.llm.listProviders !== 'function') return [];
  try {
    const raw = ctx.llm.listProviders();
    return (Array.isArray(raw) ? raw : []).map(asProvider).filter((p): p is LlmProvider => p !== null);
  } catch {
    return [];
  }
}
