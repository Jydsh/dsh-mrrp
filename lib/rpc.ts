import { readFileSync } from 'node:fs';
import type { Category, PluginConfig } from './store.js';
import { defaultRoleIdFor, sanitizeCategory, sanitizeConfig, sanitizeDecisionProvider, sanitizeDept, sanitizeRole, sanitizeUser } from './store.js';
import type { LlmContext, LlmModel, LlmProvider } from './models.js';
import { discoverModels, listProviders } from './models.js';
import { fetchProviderModels, testProvider } from './decision.js';
import { noopImReader, type ImReader } from './dshim.js';

/**
 * RPC 消息契约（lib/client.js ↔ server 管理通道）。
 * 通道：POST /api/mrrp，JSON body。与 dsh-ding-card 的 RPC 协议完全对齐。
 */

/** RPC 客户端请求消息（client.js → server）。 */
export interface RpcClientRequest {
  type: 'client-request';
  /** 请求 ID（响应回填同一 ID） */
  rpcId: string;
  /** 通道名 */
  method: 'mrrp';
  /** 具体调用 */
  payload: RpcCall;
}

/** RPC 具体调用。 */
export interface RpcCall {
  method: string;
  payload?: unknown;
}

/** RPC 错误信息。 */
export interface RpcError {
  code: string;
  message: string;
  details?: unknown;
}

/** RPC 结果。 */
export interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: RpcError;
}

/** RPC 服务端响应消息。 */
export interface RpcServerResponse {
  type: 'server-response';
  rpcId: string;
  result: RpcResult;
}

/** DSH 运行时上下文（宽松类型：DSH API 未提供完整类型定义）。 */
export interface DshCtx {
  get?: (key: string) => unknown;
  inject?: (keys: string[], callback: (connectionCtx: unknown) => void) => unknown;
  connection?: unknown;
  llm?: LlmContext['llm'];
  logger?: unknown;
}

/** installRpc 依赖注入。 */
export interface RpcDeps {
  /** 配置存储 */
  store: {
    get(): PluginConfig;
    save(input: unknown): Promise<PluginConfig>;
    path: string;
  };
  /** DSH 模型发现上下文（ctx 或注入后的 llm） */
  llm: LlmContext['llm'];
  logger?: { warn?: (...args: unknown[]) => void };
  /** dsh-im 只读读取器（senderId -> 姓名；缺省为空实现） */
  im?: ImReader;
  /** IM 消息路由引擎状态查询（route.im.status 用；缺省返回未订阅） */
  imRoutingStatus?: () => Record<string, unknown>;
  /** 路由决策日志文件路径（logs.read 用；未提供则返回空） */
  logPath?: string;
}

const RPC_CHANNEL = 'mrrp';

function reply(rpcId: string, result: RpcResult): Response {
  return Response.json({ type: 'server-response', rpcId, result });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorWith(error: unknown, fallbackCode: string, fallbackMessage: string): RpcError {  const source = (error && typeof error === 'object' ? error : {}) as Record<string, any>;
  return {
    code: typeof source.code === 'string' ? source.code : fallbackCode,
    message: (error instanceof Error ? error.message : undefined) ?? fallbackMessage,
    details: source.detail ?? {},
  };
}

export function installRpc(ctx: DshCtx, deps: RpcDeps): { install(): void; dispose(): void; syncImUsers(): Promise<number> } {
  const { store, llm, logger = console } = deps;
  const im: ImReader = deps.im ?? noopImReader();
  let registered: (() => void) | null = null;

  async function status(): Promise<unknown> {
    const config = store.get();
    let providers: LlmProvider[] = [];
    let models: LlmModel[] = [];
    let llmError: string | null = null;
    try {
      providers = listProviders({ llm } as LlmContext);
      models = await discoverModels({ llm } as LlmContext);
    } catch (error) {
      llmError = (error as Error)?.message ?? String(error);
    }
    return {
      providers: providers.length,
      models: models.length,
      categories: config.categories.length,
      roles: config.roles.length,
      depts: config.depts.length,
      users: config.users.length,
      routeActive: config.route.active,
      llmError,
      configPath: store.path,
    };
  }

  async function providersList(): Promise<unknown> {
    const providers = listProviders({ llm } as LlmContext);
    return { providers };
  }

  async function modelsList(): Promise<unknown> {
    const models = await discoverModels({ llm } as LlmContext);
    return { models };
  }

  function categoriesList(): unknown {
    return { categories: store.get().categories };
  }

  async function categoriesCreate(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const category = sanitizeCategory({
      ...payload,
      id: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (config.categories.some((item) => item.name === category.name)) {
      throw Object.assign(new Error(`已存在同名分类「${category.name}」。`), { code: 'duplicate-name' });
    }
    config.categories.push(category);
    const saved = await store.save(config);
    return { category: saved.categories.find((item) => item.id === category.id) ?? category };
  }

  async function categoriesUpdate(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const index = config.categories.findIndex((item) => item.id === id);
    if (index < 0) throw Object.assign(new Error('没有找到该分类。'), { code: 'unknown-category' });
    const merged = sanitizeCategory({ ...config.categories[index], ...payload });
    if (config.categories.some((item, i) => i !== index && item.name === merged.name)) {
      throw Object.assign(new Error(`已存在同名分类「${merged.name}」。`), { code: 'duplicate-name' });
    }
    config.categories[index] = merged;
    const saved = await store.save(config);
    return { category: saved.categories.find((item) => item.id === id) ?? merged };
  }

  async function categoriesDelete(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const target = config.categories.find((item) => item.id === id);
    if (!target) throw Object.assign(new Error('没有找到该分类。'), { code: 'unknown-category' });
    if (target.isDefault) {
      throw Object.assign(new Error('默认分类不能删除，请先设置其它分类为默认。'), { code: 'default-protected' });
    }
    // 删除分类时，把它绑定的模型释放为「未分类」，并解绑依赖它的角色。
    config.categories = config.categories.filter((item) => item.id !== id);
    config.roles = config.roles.map((role) => ({
      ...role,
      categoryBindings: role.categoryBindings.filter((b) => b.categoryId !== id),
    }));
    const saved = await store.save(config);
    return { deleted: true, categories: saved.categories };
  }

  async function categoriesBind(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const index = config.categories.findIndex((item) => item.id === id);
    if (index < 0) throw Object.assign(new Error('没有找到该分类。'), { code: 'unknown-category' });
    const modelIds = Array.isArray(payload?.modelIds) ? payload.modelIds : [];
    // 从其它分类中移除这些模型，保证一个模型只属于一个分类。
    config.categories = config.categories.map((item) => item.id === id ? item : {
      ...item,
      modelIds: item.modelIds.filter((m) => !modelIds.includes(m)),
    });
    const target = config.categories[index];
    config.categories[index] = {
      ...target,
      modelIds: Array.from(new Set([...target.modelIds, ...modelIds])),
      updatedAt: new Date().toISOString(),
    };
    const saved = await store.save(config);
    return { categories: saved.categories };
  }

  async function categoriesUnbind(payload: Record<string, any> | undefined): Promise<unknown> {
    const config = store.get();
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const index = config.categories.findIndex((item) => item.id === id);
    if (index < 0) throw Object.assign(new Error('没有找到该分类。'), { code: 'unknown-category' });
    const modelIds = Array.isArray(payload?.modelIds) ? payload.modelIds : [];
    config.categories[index] = {
      ...config.categories[index],
      modelIds: config.categories[index].modelIds.filter((m) => !modelIds.includes(m)),
      updatedAt: new Date().toISOString(),
    };
    const saved = await store.save(config);
    return { categories: saved.categories };
  }

  function routeGet(): unknown {
    return { route: store.get().route };
  }

  async function routeSave(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!isRecord(payload?.route)) throw Object.assign(new Error('路由配置格式无效。'), { code: 'bad-request' });
    const config = store.get();
    config.route = { ...config.route, ...payload.route };
    const saved = await store.save(config);
    return { route: saved.route };
  }

  function routeImStatus(): unknown {
    return deps.imRoutingStatus?.() ?? { subscribed: false, enabled: false, routedCount: 0 };
  }

  function rolesList(): unknown {
    const config = store.get();
    return { roles: config.roles, depts: config.depts };
  }

  async function rolesSave(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!Array.isArray(payload?.roles)) throw Object.assign(new Error('角色列表格式无效。'), { code: 'bad-request' });
    const config = store.get();
    config.roles = payload.roles.map(sanitizeRole);
    syncDeptRoles(config);
    pruneUserRefs(config);
    const saved = await store.save(config);
    return { roles: saved.roles, depts: saved.depts };
  }

  function deptsList(): unknown {
    const config = store.get();
    return { depts: config.depts, roles: config.roles, users: config.users };
  }

  /**
   * 修复部门树：悬空的 parentId（上级不存在）提升为顶级；返回循环引用所在部门 id（无环则 null）。
   */
  function repairDeptTree(depts: Array<{ id: string; parentId: string }>): string | null {
    const ids = new Set(depts.map((d) => d.id));
    for (const d of depts) {
      if (d.parentId && !ids.has(d.parentId)) d.parentId = '';
    }
    const byId = new Map(depts.map((d) => [d.id, d]));
    for (const d of depts) {
      const seen = new Set<string>();
      let cur: { id: string; parentId: string } | undefined = d;
      while (cur && cur.parentId) {
        if (seen.has(cur.id)) return cur.id;
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
      if (cur && seen.has(cur.id)) return cur.id;
    }
    return null;
  }

  async function deptsSave(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!Array.isArray(payload?.depts)) throw Object.assign(new Error('部门列表格式无效。'), { code: 'bad-request' });
    const config = store.get();
    config.depts = payload.depts.map(sanitizeDept);
    const cycleId = repairDeptTree(config.depts);
    if (cycleId) {
      throw Object.assign(new Error('部门上级关系存在循环引用，请检查上级部门设置。'), { code: 'invalid-dept-cycle' });
    }
    syncRoleDepts(config);
    pruneUserRefs(config);
    const saved = await store.save(config);
    return { depts: saved.depts, roles: saved.roles, users: saved.users };
  }

  /**
   * 扫描 dsh-im 里出现过的发送者，凡不在用户表的一律自动创建用户
   * （id = senderId 唯一标识，name = sender_name，角色 / 部门留空）。静默失败，不影响主流程。
   */
  async function syncImUsers(): Promise<number> {
    let senders;
    try {
      senders = await im.readSenders();
    } catch {
      return 0;
    }
    if (!senders.length) return 0;
    const config = store.get();
    const known = new Set(config.users.map((user) => user.id));
    const defaultRoleId = defaultRoleIdFor(config);
    let created = 0;
    const fresh: PluginConfig['users'] = [];
    for (const sender of senders) {
      const id = (sender.senderId || '').trim();
      if (!id || known.has(id)) continue;
      known.add(id);
      fresh.push({
        id,
        name: (sender.senderName || '').trim() || id,
        roleId: defaultRoleId,
        deptIds: [],
        note: '',
      });
      created += 1;
    }
    if (created) {
      config.users = [...config.users, ...fresh.map(sanitizeUser)];
      await store.save(config);
    }
    return created;
  }

  async function usersList(): Promise<unknown> {
    // 自动把 dsh-im 首次进来的发送者补进用户表（「第一次进来的用户自动创建用户」）。
    try { await syncImUsers(); } catch { /* 忽略同步失败，仍返回当前用户列表 */ }
    const config = store.get();
    return { users: config.users, roles: config.roles, depts: config.depts };
  }

  async function usersSave(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!Array.isArray(payload?.users)) throw Object.assign(new Error('用户列表格式无效。'), { code: 'bad-request' });
    const config = store.get();
    config.users = payload.users.map(sanitizeUser);
    pruneUserRefs(config);
    const saved = await store.save(config);
    return { users: saved.users };
  }

  /**
   * users.resolve：把 dsh-im 的 senderId 解析为用户。
   *  - 不带 senderId：返回 dsh-im 中出现过的发送者列表（senderId + 姓名，供新建用户时选择导入）。
   *  - 带 senderId：解析姓名；用户表里不存在该 senderId 时默认自动创建用户（create:false 时仅解析，不创建）。
   */
  async function usersResolve(payload: Record<string, any> | undefined): Promise<unknown> {
    const senderId = typeof payload?.senderId === 'string' ? payload.senderId.trim() : '';
    const autoCreate = payload?.create !== false;
    if (!senderId) {
      let senders: unknown[] = [];
      try { senders = await im.readSenders(); } catch { /* ignore */ }
      return { senders };
    }
    let name: string | null = null;
    try { name = await im.resolveName(senderId); } catch { /* ignore */ }
    const config = store.get();
    const existing = config.users.find((user) => user.id === senderId);
    if (existing) return { user: existing, name: name ?? existing.name, created: false };
    if (!autoCreate) return { user: null, name, created: false };
    const user = sanitizeUser({ id: senderId, name: name || senderId, roleId: defaultRoleIdFor(config), deptIds: [], note: '' });
    config.users.push(user);
    await store.save(config);
    return { user, name: name ?? user.name, created: true };
  }

  async function usersSyncIm(): Promise<unknown> {
    const created = await syncImUsers();
    const config = store.get();
    return { created, users: config.users, roles: config.roles, depts: config.depts };
  }

  async function sidebarEntryGet(): Promise<unknown> {
    const config = store.get();
    return { mode: config.sidebar?.mode ?? 'auto', visible: sidebarVisibleFor(config) };
  }

  async function sidebarEntrySet(payload: Record<string, any> | undefined): Promise<unknown> {
    const mode = payload?.mode === 'show' || payload?.mode === 'hide' ? payload.mode : 'auto';
    const saved = await store.save({ ...store.get(), sidebar: { mode } });
    return { mode, visible: sidebarVisibleFor(saved) };
  }

  function userDefaultsGet(): unknown {
    return { roleId: store.get().userDefaults?.roleId ?? '' };
  }

  function modelProfileList(): unknown {
    return { profiles: store.get().modelProfiles ?? {} };
  }

  async function modelProfileSet(payload: Record<string, any> | undefined): Promise<unknown> {
    const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
    if (!key || key.length > 256) throw Object.assign(new Error('模型标识无效。'), { code: 'bad-request' });
    const type = typeof payload?.type === 'string' ? payload.type.trim().slice(0, 40) : '';
    const scene = typeof payload?.scene === 'string' ? payload.scene.trim().slice(0, 200) : '';
    const config = store.get();
    const next = { ...(config.modelProfiles ?? {}) };
    if (type || scene) next[key] = { type, scene };
    else delete next[key];
    const saved = await store.save({ ...config, modelProfiles: next });
    return { profiles: saved.modelProfiles ?? {} };
  }

  async function userDefaultsSet(payload: Record<string, any> | undefined): Promise<unknown> {
    const roleId = typeof payload?.roleId === 'string' ? payload.roleId.trim() : '';
    const config = store.get();
    if (roleId && !config.roles.some((role) => role.id === roleId)) {
      throw Object.assign(new Error('默认角色不存在，请先创建该角色。'), { code: 'bad-request' });
    }
    const previousRoleId = config.userDefaults?.roleId ?? '';
    const saved = await store.save({ ...config, userDefaults: { roleId } });
    return { roleId: saved.userDefaults?.roleId ?? '', previousRoleId };
  }

  function decisionList(): unknown {
    return { providers: store.get().decisionProviders };
  }

  async function decisionSave(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!isRecord(payload?.provider)) throw Object.assign(new Error('提供方配置格式无效。'), { code: 'bad-request' });
    const config = store.get();
    const provider = sanitizeDecisionProvider({
      ...payload.provider,
      id: payload.provider?.id || undefined,
      updatedAt: new Date().toISOString(),
    });
    const index = config.decisionProviders.findIndex((item) => item.id === provider.id);
    if (index >= 0) {
      config.decisionProviders[index] = provider;
    } else {
      config.decisionProviders.push({ ...provider, createdAt: new Date().toISOString() });
    }
    const saved = await store.save(config);
    return { provider: saved.decisionProviders.find((item) => item.id === provider.id) ?? provider };
  }

  async function decisionDelete(payload: Record<string, any> | undefined): Promise<unknown> {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const config = store.get();
    config.decisionProviders = config.decisionProviders.filter((item) => item.id !== id);
    const saved = await store.save(config);
    return { deleted: true, providers: saved.decisionProviders };
  }

  async function decisionFetch(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!isRecord(payload?.provider)) throw Object.assign(new Error('提供方配置格式无效。'), { code: 'bad-request' });
    const provider = sanitizeDecisionProvider(payload.provider);
    return fetchProviderModels(provider);
  }

  async function decisionTest(payload: Record<string, any> | undefined): Promise<unknown> {
    if (!isRecord(payload?.provider)) throw Object.assign(new Error('提供方配置格式无效。'), { code: 'bad-request' });
    const provider = sanitizeDecisionProvider(payload.provider);
    return testProvider(provider);
  }

  /** 读取路由决策日志（route-decision.log，append JSON 行），返回最新在前、最多 limit 条。 */
  function logsRead(payload: Record<string, any> | undefined): { logs: Record<string, unknown>[]; path: string } {
    const want = typeof payload?.limit === 'number' && Number.isFinite(payload.limit) ? Math.floor(payload.limit) : 200;
    const cap = Math.max(1, Math.min(want, 1000));
    const path = deps.logPath ?? '';
    if (!path) return { logs: [], path };
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return { logs: [], path };
    }
    const rows: Record<string, unknown>[] = [];
    for (const line of text.split('\n').slice(-cap)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
      } catch { /* 坏行跳过，不影响其它日志 */ }
    }
    rows.reverse(); // 最新在前
    return { logs: rows, path };
  }

  async function dispatch(method: string, payload: Record<string, any> | undefined): Promise<unknown> {
    if (method === 'status') return status();
    if (method === 'providers.list') return providersList();
    if (method === 'models.list') return modelsList();
    if (method === 'config.get') return { config: sanitizeConfig(store.get()) };
    if (method === 'config.save') {
      if (!isRecord(payload?.config)) throw Object.assign(new Error('配置格式无效。'), { code: 'bad-request' });
      const saved = await store.save(payload.config);
      return { config: saved };
    }
    if (method === 'categories.list') return categoriesList();
    if (method === 'categories.create') return categoriesCreate(payload);
    if (method === 'categories.update') return categoriesUpdate(payload);
    if (method === 'categories.delete') return categoriesDelete(payload);
    if (method === 'categories.bind') return categoriesBind(payload);
    if (method === 'categories.unbind') return categoriesUnbind(payload);
    if (method === 'route.get') return routeGet();
    if (method === 'route.save') return routeSave(payload);
    if (method === 'route.im.status') return routeImStatus();
    if (method === 'roles.list') return rolesList();
    if (method === 'roles.save') return rolesSave(payload);
    if (method === 'depts.list') return deptsList();
    if (method === 'depts.save') return deptsSave(payload);
    if (method === 'users.list') return usersList();
    if (method === 'users.save') return usersSave(payload);
    if (method === 'users.resolve') return usersResolve(payload);
    if (method === 'users.syncIm') return usersSyncIm();
    if (method === 'sidebar-entry.get') return sidebarEntryGet();
    if (method === 'sidebar-entry.set') return sidebarEntrySet(payload);
    if (method === 'userDefaults.get') return userDefaultsGet();
    if (method === 'userDefaults.set') return userDefaultsSet(payload);
    if (method === 'modelProfile.list') return modelProfileList();
    if (method === 'modelProfile.set') return modelProfileSet(payload);
    if (method === 'decision.list') return decisionList();
    if (method === 'decision.save') return decisionSave(payload);
    if (method === 'decision.delete') return decisionDelete(payload);
    if (method === 'decision.fetch') return decisionFetch(payload);
    if (method === 'decision.test') return decisionTest(payload);
    if (method === 'logs.read') return logsRead(payload);
    throw Object.assign(new Error(`未知操作：${method}`), { code: 'unknown-method' });
  }

  function registerOn(target: unknown): void {
    const connection = (target as Record<string, any>)?.connection
      ?? (target as Record<string, any>)?.get?.('connection')
      ?? ctx?.connection;
    if (typeof (connection as Record<string, any>)?.fetch?.register !== 'function') {
      logger.warn?.('[dsh-mrrp] 当前 DSH 版本不提供 connection.fetch，管理接口未注册');
      return;
    }
    registered = (connection as Record<string, any>).fetch.register({
      path: `/api/${RPC_CHANNEL}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let message: RpcClientRequest;
        try { message = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== RPC_CHANNEL || !isRecord(call) || typeof call.method !== 'string'
          || !Object.hasOwn(call, 'payload')) {
          return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid mrrp request.' } });
        }
        try {
          const value = await dispatch(call.method, call.payload as Record<string, any>);
          return reply(rpcId, { ok: true, value });
        } catch (error) {
          logger.warn?.(`[dsh-mrrp] ${call.method} failed:`, (error as Error)?.message ?? error);
          return reply(rpcId, { ok: false, error: errorWith(error, 'operation-failed', '操作失败，请稍后重试。') });
        }
      },
    });
  }

  function install(): void {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['connection'], (connectionCtx) => registerOn(connectionCtx));
      return;
    }
    registerOn(ctx);
  }

  return {
    install,
    dispose() { registered?.(); registered = null; },
    syncImUsers,
  };
}

/** 以 role.deptIds 为权威，反向推导每个部门的 roleIds（角色页保存后同步到部门侧）。 */
function syncDeptRoles(config: PluginConfig): void {
  for (const dept of config.depts) {
    dept.roleIds = config.roles.filter((role) => role.deptIds.includes(dept.id)).map((role) => role.id);
  }
}

/** 以 dept.roleIds 为权威，反向推导每个角色的 deptIds（部门页保存后同步到角色侧）。 */
function syncRoleDepts(config: PluginConfig): void {
  for (const role of config.roles) {
    role.deptIds = config.depts.filter((dept) => dept.roleIds.includes(role.id)).map((dept) => dept.id);
  }
}

/** 清理用户对已删除角色 / 部门的引用。 */
function pruneUserRefs(config: PluginConfig): void {
  const roleIds = new Set(config.roles.map((role) => role.id));
  const deptIds = new Set(config.depts.map((dept) => dept.id));
  for (const user of config.users) {
    if (!roleIds.has(user.roleId)) user.roleId = '';
    user.deptIds = user.deptIds.filter((id) => deptIds.has(id));
  }
}

function sidebarVisibleFor(config: PluginConfig): boolean {
  const mode = config.sidebar?.mode ?? 'auto';
  if (mode === 'show') return true;
  if (mode === 'hide') return false;
  // auto：未绑定任何可用模型（分类都没绑模型）且没有角色 / 用户时显示入口引导，配置后自动隐藏。
  // 默认分类是脚手架、不携带模型，因此不算「已配置」。
  const hasBoundModel = config.categories.some((category) => category.modelIds.length > 0);
  return !hasBoundModel && config.roles.length === 0 && config.users.length === 0;
}

export { sidebarVisibleFor };
