import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Category, PluginConfig } from './store.js';
import { defaultRoleIdFor, probeLogDir, resolveRouteLogDir, sanitizeCategory, sanitizeConfig, sanitizeDecisionProvider, sanitizeDept, sanitizeLogDir, sanitizeRole, sanitizeTypeSceneList, sanitizeUser } from './store.js';
import type { LlmContext, LlmModel, LlmProvider } from './models.js';
import { discoverModels, listProviders } from './models.js';
import { fetchProviderModels, testProvider } from './decision.js';
import { noopImReader, type ImReader } from './dshim.js';
import { routeLogPathFor, effectiveDecisionProviderIds } from './route-engine.js';
import { buildDecisionSlots, defaultDecisionScheduler, decisionPoolConfig } from './decision-pool.js';

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
  /** 路由决策日志目录（logs.read / logs.settings / logs.clear 用；按天分文件 route-decision-YYYY-MM-DD.log） */
  logDir?: string;
  /** 动态取日志目录（优先于 logDir）：控制台里改了存放路径后，读写清理都即时切到新目录 */
  getLogDir?: () => string;
  /** 版本检查器（version.check / version.update 用；未提供则返回空信息） */
  updater?: {
    current(): string | null;
    check(repo?: string): Promise<import('./updater.js').LatestVersionInfo | null>;
    isAtLeast(current: string | null, latest: string | null): boolean;
    /** 识别当前安装环境（可用 profile 覆盖，见 UpdateTargetOptions） */
    detect(options?: import('./updater.js').UpdateTargetOptions): import('./updater.js').InstallEnv;
    /** 执行一键更新（可用 profile 覆盖） */
    update(options?: import('./updater.js').UpdateTargetOptions): Promise<import('./updater.js').UpdateResult>;
    /** 记住用户手动选择的 profile（下次启动直接采信） */
    remember?(profile: string): void;
  };
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

  function typeSceneList(): unknown {
    return { list: [...(store.get().typeSceneList ?? [])] };
  }

  async function typeSceneSave(payload: Record<string, any> | undefined): Promise<unknown> {
    const list = sanitizeTypeSceneList(payload?.list);
    const config = store.get();
    const saved = await store.save({ ...config, typeSceneList: list });
    return { list: [...(saved.typeSceneList ?? [])] };
  }

  async function modelProfileSet(payload: Record<string, any> | undefined): Promise<unknown> {
    const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
    if (!key || key.length > 256) throw Object.assign(new Error('模型标识无效。'), { code: 'bad-request' });
    const rawTypes = Array.isArray(payload?.type)
      ? payload.type
      : (typeof payload?.type === 'string' && payload.type.trim() ? [payload.type] : []);
    const type = Array.from(new Set(rawTypes
      .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t: string) => t.trim().slice(0, 20)))).slice(0, 5);
    const scene = typeof payload?.scene === 'string' ? payload.scene.trim().slice(0, 200) : '';
    const config = store.get();
    const next = { ...(config.modelProfiles ?? {}) };
    if (type.length || scene) next[key] = { type, scene };
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

  /**
   * 决策模型并发池状态：按当前选中的提供方展开每个槽（provider + 模型），
   * 带实时在途 / 成功 / 失败 / 冷却，用来验证「忙了自动换空闲」是否真的生效。
   */
  function decisionPoolStats(): { slots: Array<Record<string, unknown>>; config: Record<string, unknown> } {
    const config = store.get();
    const ids = effectiveDecisionProviderIds(config.route?.imRoute);
    const slots = buildDecisionSlots(config, ids);
    const pool = decisionPoolConfig(config.route?.imRoute);
    return {
      slots: defaultDecisionScheduler.stats(slots),
      config: {
        enabled: pool.enabled,
        defaultLimit: pool.defaultLimit,
        queueTimeoutMs: pool.queueTimeoutMs,
        sticky: pool.sticky,
        primaryProviderId: pool.primaryProviderId,
        primaryModel: pool.primaryModel,
      },
    };
  }

  /** 当前生效的日志目录：控制台可改存放路径，所以每次调用现取；旧注入的静态 logDir 仍兼容。 */
  function logDirNow(): string {
    try {
      const dynamic = deps.getLogDir?.();
      if (typeof dynamic === 'string' && dynamic) return dynamic;
    } catch { /* 取目录失败回退静态值 */ }
    return deps.logDir ?? '';
  }

  /** 默认日志目录：config.json 所在目录（用户未自定义时的落点，也是「恢复默认」的目标）。 */
  function defaultLogDirNow(): string {
    return dirname(store.path);
  }

  /* ---------------------------- 系统「选择文件夹」对话框 ---------------------------- */
  // 网页（渲染进程）拿不到本地绝对路径（input[type=file] 只给相对路径），所以目录选择必须由 host 侧弹原生对话框：
  //   ① Electron 自带的 dialog.showOpenDialog（宿主是 Electron 时最原生，无额外进程）；
  //   ② 回退到 Windows 的 FolderBrowserDialog（PowerShell -STA 弹窗，其他平台不支持）。
  // 弹窗可能停留很久，用「start + poll」两段式：start 立刻返回 id，前端轮询 poll 取结果，避免长时间阻塞 RPC。

  type DirPickState = 'pending' | 'done' | 'canceled' | 'unsupported' | 'error';
  let dirPick: { id: string; state: DirPickState; path: string; message: string; startedAt: number } | null = null;

  async function pickDirViaElectron(defaultPath: string): Promise<{ path?: string; canceled?: boolean } | null> {
    try {
      // 用变量传模块名，避免 TS 在编译期去解析 electron 的类型（插件本身不依赖 electron）
      const electronModule = 'electron';
      const mod = (await import(/* @vite-ignore */ electronModule)) as Record<string, any>;
      const dialog = mod?.dialog ?? mod?.default?.dialog;
      if (typeof dialog?.showOpenDialog !== 'function') return null;
      const result = await dialog.showOpenDialog({
        title: '选择日志存放目录',
        defaultPath: defaultPath || undefined,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '选这个目录',
      });
      if (!result || result.canceled) return { canceled: true };
      const chosen = Array.isArray(result.filePaths) ? result.filePaths[0] : '';
      return chosen ? { path: chosen } : { canceled: true };
    } catch {
      return null; // 不在 Electron 里 / 加载失败 → 交给平台回退
    }
  }

  function pickDirViaPowerShell(defaultPath: string): Promise<{ path?: string; canceled?: boolean } | null> {
    if (process.platform !== 'win32') return Promise.resolve(null);
    const seed = defaultPath.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dlg.Description = '选择日志存放目录'",
      '$dlg.ShowNewFolderButton = $true',
      seed ? `$dlg.SelectedPath = '${seed}'` : '',
      'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
    ].filter(Boolean).join('; ');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 240_000, windowsHide: true }, (error, stdout) => {
        if (error) { resolve(null); return; } // 弹不出来（无桌面会话等）→ 视为不支持
        const chosen = String(stdout || '').trim();
        resolve(chosen ? { path: chosen } : { canceled: true });
      });
    });
  }

  const DIR_PICK_TIMEOUT_MS = 5 * 60 * 1000;

  /** 启动一次目录选择：立刻返回 id；对话框在后台弹，结果用 logs.dir.pick.poll 取。 */
  function logsDirPickStart(payload: Record<string, any> | undefined): { id: string; state: DirPickState } {
    if (dirPick && dirPick.state === 'pending' && Date.now() - dirPick.startedAt < DIR_PICK_TIMEOUT_MS) {
      return { id: dirPick.id, state: dirPick.state }; // 已有对话框在等 → 复用，避免弹两个
    }
    const seed = (typeof payload?.defaultDir === 'string' ? sanitizeLogDir(payload.defaultDir) : '') || logDirNow() || defaultLogDirNow();
    const id = `pick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // 无桌面会话 / 无人值守部署可以用 MRRP_DISABLE_NATIVE_PICK=1 关掉原生弹窗，避免弹出的窗口挂着不走。
    if (process.env.MRRP_DISABLE_NATIVE_PICK === '1') {
      dirPick = {
        id, state: 'unsupported', path: '', startedAt: Date.now(),
        message: '当前环境已关闭系统文件夹选择框（MRRP_DISABLE_NATIVE_PICK=1），请直接在输入框填写绝对路径。',
      };
      return { id, state: 'unsupported' };
    }
    const record = { id, state: 'pending' as DirPickState, path: '', message: '', startedAt: Date.now() };
    dirPick = record;
    void (async () => {
      const viaElectron = await pickDirViaElectron(seed);
      const result = viaElectron === null ? await pickDirViaPowerShell(seed) : viaElectron;
      if (!dirPick || dirPick.id !== id) return; // 被更新的请求覆盖
      if (result === null) {
        dirPick.state = 'unsupported';
        dirPick.message = '当前环境打不开系统文件夹选择框，请直接在输入框填写绝对路径（例如 D:\\dsh-logs）。';
        return;
      }
      if (result.path) { dirPick.state = 'done'; dirPick.path = result.path; return; }
      dirPick.state = 'canceled';
    })().catch((error: unknown) => {
      if (dirPick && dirPick.id === id) {
        dirPick.state = 'error';
        dirPick.message = error instanceof Error ? error.message : String(error);
      }
    });
    return { id, state: 'pending' };
  }

  /** 轮询目录选择结果。 */
  function logsDirPickPoll(payload: Record<string, any> | undefined): { state: DirPickState | 'expired'; path: string; message: string } {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!dirPick || (id && dirPick.id !== id)) {
      return { state: 'expired', path: '', message: '这次选择已经结束，请重新点击「浏览…」。' };
    }
    if (dirPick.state === 'pending' && Date.now() - dirPick.startedAt > DIR_PICK_TIMEOUT_MS) {
      dirPick.state = 'error';
      dirPick.message = '等待选择超时，请重新点击「浏览…」或手动填写路径。';
    }
    return { state: dirPick.state, path: dirPick.path, message: dirPick.message };
  }

  /** 读取当天路由决策日志（route-decision-YYYY-MM-DD.log，append JSON 行），返回最新在前、最多 limit 条。 */
  function logsRead(payload: Record<string, any> | undefined): { logs: Record<string, unknown>[]; path: string } {
    const want = typeof payload?.limit === 'number' && Number.isFinite(payload.limit) ? Math.floor(payload.limit) : 200;
    const cap = Math.max(1, Math.min(want, 1000));
    const dir = logDirNow();
    const path = dir ? routeLogPathFor(dir) : '';
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

  /** 日志设置读取：保留天数 + 存放目录（配置值 / 生效值 / 默认值）+ 当天日志文件路径 / 大小 / 行数 / 历史文件数。 */
  function logsSettingsGet(): {
    retentionDays: number; path: string; bytes: number; lineCount: number; files: number;
    logDir: string; resolvedDir: string; defaultDir: string; isCustom: boolean; dirExists: boolean;
  } {
    const retentionDays = store.get().logRetentionDays || 30;
    const custom = sanitizeLogDir(store.get().logDir);
    const dir = logDirNow();
    const defaultDir = defaultLogDirNow();
    const path = dir ? routeLogPathFor(dir) : '';
    let bytes = 0;
    let lineCount = 0;
    let files = 0;
    if (path) {
      try {
        const text = readFileSync(path, 'utf8');
        bytes = Buffer.byteLength(text);
        lineCount = text.split('\n').filter((line) => line.trim()).length;
      } catch { /* 当天日志文件尚不存在：视为 0 */ }
    }
    if (dir) {
      try {
        files = readdirSync(dir).filter((name) => /^route-decision.*\.log$/.test(name)).length;
      } catch { /* 目录不可读：视为 0 */ }
    }
    let dirExists = false;
    if (dir) {
      try { dirExists = statSync(dir).isDirectory(); } catch { dirExists = false; }
    }
    return {
      retentionDays, path, bytes, lineCount, files,
      logDir: custom, resolvedDir: dir, defaultDir, isCustom: Boolean(custom), dirExists,
    };
  }

  /** 日志设置保存：自动清理保留天数（1~365）+ 日志存放目录。
   *  目录只接受绝对路径；空串 = 恢复默认（config.json 所在目录）。
   *  保存前会真实创建目录并写一次探针文件，写不进去就直接报错，避免「设置成功但日志静默丢失」。 */
  async function logsSettingsSet(payload: Record<string, any> | undefined): Promise<{
    retentionDays: number; logDir: string; resolvedDir: string; defaultDir: string; isCustom: boolean;
  }> {
    const config = store.get();
    const patch: Record<string, unknown> = {};
    if (payload?.retentionDays !== undefined) {
      const raw = Number(payload.retentionDays);
      patch.logRetentionDays = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.round(raw))) : 30;
    }
    if (payload?.logDir !== undefined) {
      const raw = typeof payload.logDir === 'string' ? payload.logDir.trim() : '';
      const next = sanitizeLogDir(raw);
      if (raw && !next) {
        throw Object.assign(new Error('日志目录必须是绝对路径（例如 D:\\dsh-logs 或 /var/log/mrrp），留空则使用默认目录。'), { code: 'bad-log-dir' });
      }
      if (next) {
        const bad = probeLogDir(next);
        if (bad) throw Object.assign(new Error(`该目录无法创建或写入：${bad}`), { code: 'log-dir-not-writable' });
      }
      patch.logDir = next;
    }
    const saved = await store.save({ ...config, ...patch });
    const custom = sanitizeLogDir(saved.logDir);
    return {
      retentionDays: saved.logRetentionDays || 30,
      logDir: custom,
      resolvedDir: resolveRouteLogDir(store.path, custom),
      defaultDir: defaultLogDirNow(),
      isCustom: Boolean(custom),
    };
  }

  /** 清空全部路由决策日志：删除目录下所有按天日志文件（route-decision-YYYY-MM-DD.log）与旧版 route-decision.log，
   *  返回删除的行数与文件数。 */
  function logsClear(): { removed: number; files: number; path: string } {
    const dir = logDirNow();
    if (!dir) return { removed: 0, files: 0, path: '' };
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return { removed: 0, files: 0, path: dir }; }
    let removed = 0;
    let files = 0;
    for (const name of names) {
      if (!/^route-decision.*\.log$/.test(name)) continue;
      const full = join(dir, name);
      try {
        const text = readFileSync(full, 'utf8');
        removed += text.split('\n').filter((line) => line.trim()).length;
        unlinkSync(full);
        files += 1;
      } catch { /* 单个文件删除失败静默跳过，不影响其它文件 */ }
    }
    return { removed, files, path: dir };
  }

  /** 仅允许操作本插件日志文件名（route-decision*.log），防止路径穿越。 */
  function logsFileNameOf(payload: Record<string, any> | undefined): string {
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    return /^route-decision[^\\/]*\.log$/.test(name) ? name : '';
  }

  /** 列出全部路由决策日志文件（当天 + 历史 route-decision*.log）：名称 / 路径 / 大小 / 条数 / 修改时间。 */
  function logsFilesList(): { files: { name: string; path: string; bytes: number; lineCount: number; mtime: number }[] } {
    const dir = logDirNow();
    if (!dir) return { files: [] };
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return { files: [] }; }
    const files: { name: string; path: string; bytes: number; lineCount: number; mtime: number }[] = [];
    for (const name of names) {
      if (!/^route-decision[^\\/]*\.log$/.test(name)) continue;
      const full = join(dir, name);
      try {
        const text = readFileSync(full, 'utf8');
        files.push({
          name,
          path: full,
          bytes: Buffer.byteLength(text),
          lineCount: text.split('\n').filter((line) => line.trim()).length,
          mtime: statSync(full).mtimeMs,
        });
      } catch { /* 单文件不可读则跳过 */ }
    }
    files.sort((a, b) => b.mtime - a.mtime); // 最新在前
    return { files };
  }

  /** 读取指定日志文件的记录（最新在前、最多 limit 条）。
   *  返回 rows: [{ raw: 原始行文本, data: 解析后的 JSON 对象（坏行 data 为 null）}]，raw 可用于按行删除。 */
  function logsFileRead(payload: Record<string, any> | undefined): { name: string; path: string; rows: { raw: string; data: Record<string, unknown> | null }[]; total: number } {
    const name = logsFileNameOf(payload);
    const dir = logDirNow();
    if (!name || !dir) return { name, path: '', rows: [], total: 0 };
    const full = join(dir, name);
    let text = '';
    try { text = readFileSync(full, 'utf8'); } catch { return { name, path: full, rows: [], total: 0 }; }
    const lines = text.split('\n').filter((line) => line.trim());
    const rows: { raw: string; data: Record<string, unknown> | null }[] = lines.map((line) => {
      let data: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      } catch { /* 坏行：data 保持 null */ }
      return { raw: line, data };
    });
    const want = typeof payload?.limit === 'number' && Number.isFinite(payload.limit) ? Math.floor(payload.limit) : 200;
    const cap = Math.max(1, Math.min(want, 1000));
    const tail = rows.slice(-cap).reverse(); // 最新在前
    return { name, path: full, rows: tail, total: rows.length };
  }

  /** 按原始行文本删除指定日志文件中的记录（勾选删除），返回删除行数。 */
  function logsFileDropRows(payload: Record<string, any> | undefined): { name: string; removed: number } {
    const name = logsFileNameOf(payload);
    const dir = logDirNow();
    if (!name || !dir) return { name, removed: 0 };
    const raws = Array.isArray(payload?.raws) ? payload.raws.filter((s) => typeof s === 'string' && s.trim()) : [];
    if (!raws.length) return { name, removed: 0 };
    const full = join(dir, name);
    let text = '';
    try { text = readFileSync(full, 'utf8'); } catch { return { name, removed: 0 }; }
    const dropSet = new Set(raws.map((r) => r.trim()));
    const lines = text.split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (dropSet.has(trimmed)) { removed += 1; continue; }
      kept.push(line);
    }
    try {
      writeFileSync(full, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    } catch { return { name, removed: 0 }; }
    return { name, removed };
  }

  /** 删除指定日志文件（整文件），返回删除的行数。 */
  function logsFileClear(payload: Record<string, any> | undefined): { name: string; removed: number } {
    const name = logsFileNameOf(payload);
    const dir = logDirNow();
    if (!name || !dir) return { name, removed: 0 };
    const full = join(dir, name);
    let removed = 0;
    try {
      const text = readFileSync(full, 'utf8');
      removed = text.split('\n').filter((line) => line.trim()).length;
      unlinkSync(full);
    } catch { /* 不存在 / 删除失败：返回 0，不影响主链路 */ }
    return { name, removed };
  }

  /** 按条件清理指定日志文件的记录（可同时叠加）：
   *  beforeTs：删除 ts 早于该毫秒时间戳的行（如「保留最近 N 天」）；
   *  dropKeyword：删除 message/detail 含该关键词的行；
   *  keepKeyword：只保留 message/detail 含该关键词的行。返回删除行数。 */
  function logsFilePrune(payload: Record<string, any> | undefined): { name: string; removed: number } {
    const name = logsFileNameOf(payload);
    const dir = logDirNow();
    if (!name || !dir) return { name, removed: 0 };
    const full = join(dir, name);
    const beforeTs = typeof payload?.beforeTs === 'number' && Number.isFinite(payload.beforeTs) ? payload.beforeTs : NaN;
    const dropKeyword = typeof payload?.dropKeyword === 'string' && payload.dropKeyword.trim() ? payload.dropKeyword.trim() : '';
    const keepKeyword = typeof payload?.keepKeyword === 'string' && payload.keepKeyword.trim() ? payload.keepKeyword.trim() : '';
    if (!Number.isFinite(beforeTs) && !dropKeyword && !keepKeyword) return { name, removed: 0 };
    let text = '';
    try { text = readFileSync(full, 'utf8'); } catch { return { name, removed: 0 }; }
    const lines = text.split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ts = NaN;
      let body = line;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          const rawTs = parsed.ts;
          ts = typeof rawTs === 'string' ? new Date(rawTs).getTime() : Number(rawTs);
          body = String(parsed.message ?? '') + String(parsed.detail ?? '') + JSON.stringify(parsed);
        }
      } catch { /* 坏行按原始文本参与关键词判断 */ }
      const expired = Number.isFinite(beforeTs) && Number.isFinite(ts) && ts < beforeTs;
      const dropHit = dropKeyword && body.includes(dropKeyword);
      const keepMiss = keepKeyword && !body.includes(keepKeyword);
      if (expired || dropHit || keepMiss) { removed += 1; continue; }
      kept.push(line);
    }
    try {
      writeFileSync(full, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    } catch { return { name, removed: 0 }; }
    return { name, removed };
  }

  /** 版本检查：对比当前插件版本与 GitHub 最新 Release，并返回本机安装环境识别结果。
   *  仓库路径优先取 config.updateRepo，缺省用插件默认仓库（Jydsh/dsh-mrrp）。 */
  async function versionCheck(): Promise<unknown> {
    const updater = deps.updater;
    if (!updater) {
      return {
        current: null, latest: null, source: null, updateAvailable: false,
        command: null, repo: null, env: null,
      };
    }
    const repo = store.get().updateRepo;
    const target = typeof repo === 'string' && repo.trim() ? repo.trim() : undefined;
    const current = updater.current();
    const latest = await updater.check(target);
    const updateAvailable = Boolean(current && latest && !updater.isAtLeast(current, latest.version));
    // 命令按本机真实环境算出，与「一键更新」实际执行的完全一致
    const env = latest ? updater.detect({ repo: target, version: latest.version }) : null;
    return {
      current,
      latest: latest?.version ?? null,
      source: latest?.source ?? null,
      updateAvailable,
      command: updateAvailable ? env?.command || null : null,
      env,
      repo: target ?? null,
      // profile 结论与候选列表：前端据此决定是直接更新，还是先让用户选是哪一个环境
      profile: env?.profile ?? null,
      profileSource: env?.profileSource ?? null,
      candidates: env?.candidates ?? [],
    };
  }

  /** 一键更新：按识别出的本机环境执行对应安装命令（dsh plugin / pnpm / npm）。
   *  payload.profile 存在时按用户选择的 profile 执行，并记住该选择。 */
  async function versionUpdate(payload: Record<string, any> | undefined): Promise<unknown> {
    const updater = deps.updater;
    if (!updater) throw Object.assign(new Error('当前环境不支持一键更新。'), { code: 'unsupported' });
    const repo = store.get().updateRepo;
    const target = typeof repo === 'string' && repo.trim() ? repo.trim() : undefined;
    const requested = typeof payload?.profile === 'string' ? payload.profile.trim() : '';
    const latest = await updater.check(target);
    if (!latest) {
      throw Object.assign(new Error('无法获取最新版本，请检查网络或稍后重试。'), { code: 'no-latest' });
    }
    const result = await updater.update({
      repo: target,
      version: latest.version,
      profile: requested || undefined,
    });
    if (result.ok && requested) updater.remember?.(requested);
    return { ...result, latest: latest.version, profile: result.env.profile, requestedProfile: requested || null };
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
    if (method === 'typeScene.list') return typeSceneList();
    if (method === 'typeScene.save') return typeSceneSave(payload);
    if (method === 'decision.list') return decisionList();
    if (method === 'decision.save') return decisionSave(payload);
    if (method === 'decision.delete') return decisionDelete(payload);
    if (method === 'decision.fetch') return decisionFetch(payload);
    if (method === 'decision.test') return decisionTest(payload);
    if (method === 'decision.pool.stats') return decisionPoolStats();
    if (method === 'logs.read') return logsRead(payload);
    if (method === 'logs.settings.get') return logsSettingsGet();
    if (method === 'logs.settings.set') return logsSettingsSet(payload);
    if (method === 'logs.dir.pick.start') return logsDirPickStart(payload);
    if (method === 'logs.dir.pick.poll') return logsDirPickPoll(payload);
    if (method === 'logs.clear') return logsClear();
    if (method === 'logs.files.list') return logsFilesList();
    if (method === 'logs.file.read') return logsFileRead(payload);
    if (method === 'logs.file.dropRows') return logsFileDropRows(payload);
    if (method === 'logs.file.clear') return logsFileClear(payload);
    if (method === 'logs.file.prune') return logsFilePrune(payload);
    if (method === 'version.check') return versionCheck();
    if (method === 'version.update') return versionUpdate(payload);
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
