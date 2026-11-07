/**
 * 权限解析与工具闸门判定。
 *
 * 设计口径（安全优先）：
 *  - 用户 / 角色 / 部门三处绑定的权限 **取最严合并**（能力开关逐项 AND，沙箱/审批取更严的一侧）；
 *  - 一个用户没有任何绑定（且没配默认权限）就是 `bound=false`，由调用方直接拒绝；
 *  - 工具按「工具名 → 能力组」归类，命中哪一组就要求对应开关为真；
 *    无法归类的工具默认放行，但会被记录成 `unknown`，便于事后补规则（否则会把 agent 直接废掉）。
 */
import { DEFAULT_PERMISSIONS, PERMISSION_CAPS_ALL, } from './store.js';
/** 沙箱模式严格程度排序（数字越大越宽松）。 */
const SANDBOX_RANK = {
    'read-only': 0,
    'workspace-write': 1,
    'danger-full-access': 2,
};
/** 审批严格程度排序（数字越大越宽松）：ask 比 never 严。 */
const APPROVAL_RANK = { ask: 0, never: 1 };
/** 一个永远拒绝的结果。 */
export const PERMISSION_DENY_ALL = Object.freeze({
    bound: false,
    ruleIds: [],
    sources: [],
    caps: { chat: false, fsWrite: false, exec: false, pluginManage: false, power: false, computerUse: false },
    toolAllow: [],
    sandbox: 'read-only',
    approval: 'ask',
});
/** 收集用户的权限绑定 id 及来源（用户 > 角色 > 部门 > 部门下角色）。 */
export function collectPermissionBindings(config, userId) {
    const ids = [];
    const sources = [];
    const pushRule = (ruleId, source) => {
        const id = String(ruleId ?? '').trim();
        if (!id)
            return;
        if (!ids.includes(id))
            ids.push(id);
        if (!sources.includes(source))
            sources.push(source);
    };
    const user = (config.users ?? []).find((u) => u.id === userId);
    if (!user)
        return { ids: [], sources: [] };
    for (const permId of user.permissionIds ?? [])
        pushRule(permId, '用户');
    const seenRoles = new Set();
    const pushRole = (roleId, source) => {
        const id = String(roleId ?? '').trim();
        if (!id || seenRoles.has(id))
            return;
        seenRoles.add(id);
        const role = (config.roles ?? []).find((r) => r.id === id);
        if (!role)
            return;
        for (const permId of role.permissionIds ?? [])
            pushRule(permId, source);
    };
    if (user.roleId)
        pushRole(user.roleId, '用户角色');
    for (const deptId of user.deptIds ?? []) {
        const dept = (config.depts ?? []).find((d) => d.id === deptId);
        if (!dept)
            continue;
        for (const permId of dept.permissionIds ?? [])
            pushRule(permId, `部门 ${dept.name || dept.id}`);
        for (const roleId of dept.roleIds ?? [])
            pushRole(roleId, `部门角色 ${dept.name || dept.id}`);
    }
    return { ids, sources };
}
/** 最严合并多条权限规则；没有规则时用 fallback（默认权限）或拒绝。 */
export function mergePermissions(config, rules, sources) {
    if (!rules.length)
        return { ...PERMISSION_DENY_ALL, sources };
    const caps = { ...PERMISSION_CAPS_ALL };
    for (const rule of rules) {
        for (const key of Object.keys(caps)) {
            if (!rule.caps[key])
                caps[key] = false;
        }
    }
    // 显式声明「可对话」才算真的能对话（一条规则都没声明 chat=false 时仍按有 chat 处理）
    if (!rules.some((rule) => rule.caps.chat))
        caps.chat = false;
    let sandbox = '';
    for (const rule of rules) {
        if (!rule.sandbox)
            continue;
        if (!sandbox || SANDBOX_RANK[rule.sandbox] < SANDBOX_RANK[sandbox])
            sandbox = rule.sandbox;
    }
    let approval = '';
    for (const rule of rules) {
        if (!rule.approval)
            continue;
        if (!approval || APPROVAL_RANK[rule.approval] < APPROVAL_RANK[approval])
            approval = rule.approval;
    }
    // 工具白名单：只有非空的规则参与交集（空白名单视为不限制）
    const allowLists = rules.map((rule) => rule.toolAllow ?? []).filter((list) => list.length > 0);
    let toolAllow = [];
    if (allowLists.length) {
        toolAllow = allowLists[0].filter((name) => allowLists.every((list) => list.some((n) => n.toLowerCase() === name.toLowerCase())));
    }
    return {
        bound: true,
        ruleIds: rules.map((rule) => rule.id),
        sources,
        caps,
        toolAllow,
        sandbox,
        approval,
    };
}
/** 解析某用户的最终权限：用户/角色/部门绑定 → 最严合并；没有绑定则按 defaultPermissionId（空 = 拒绝）。 */
export function resolveUserPermission(config, userId) {
    const { ids, sources } = collectPermissionBindings(config, userId);
    // 配置里没有权限表时（老配置 / 测试夹具）退回内置三条，避免直接把所有人拒掉
    const table = config.permissions && config.permissions.length
        ? config.permissions
        : DEFAULT_PERMISSIONS;
    const rules = ids.map((id) => table.find((rule) => rule.id === id)).filter((rule) => !!rule);
    if (rules.length)
        return mergePermissions(config, rules, sources);
    const fallbackId = String(config.defaultPermissionId ?? '').trim();
    if (fallbackId) {
        const fallbackRule = table.find((rule) => rule.id === fallbackId)
            ?? DEFAULT_PERMISSIONS.find((rule) => rule.id === fallbackId);
        if (fallbackRule) {
            return {
                ...mergePermissions(config, [{ ...fallbackRule, caps: { ...fallbackRule.caps }, toolAllow: [...fallbackRule.toolAllow] }], ['默认权限']),
                bound: true,
            };
        }
    }
    return { ...PERMISSION_DENY_ALL, sources: sources.length ? sources : ['未绑定权限'] };
}
/** 工具名 → 能力组（保守归类：宁可按更高风险组处理）。 */
export function toolGroupOf(toolName) {
    const name = String(toolName ?? '').trim().toLowerCase();
    if (!name)
        return 'other';
    // 命令执行：bash / pwsh / shell / 终端 / cmd / 脚本执行
    if (/(^|[^a-z])(bash|pwsh|powershell|shell|terminal|cmd|exec|run_command)/.test(name))
        return 'exec';
    // 子 agent / 定时任务 / 工作流：都能间接驱动工具，按 exec 级要求
    if (/(subagent|workflow|schedule|cron|job)/.test(name))
        return 'exec';
    // 插件管理
    if (/(plugin|cordis|install|uninstall|bundle)/.test(name))
        return 'pluginManage';
    // 电源 / 系统级
    if (/(power|shutdown|reboot|sleep|restart|halt)/.test(name))
        return 'power';
    // 桌面 / 浏览器接管
    if (/(computer|desktop|browser|screenshot|screen_capture|wet_control)/.test(name))
        return 'computerUse';
    // 写文件类
    if (/(write|edit|patch|replace|create_file|append)/.test(name))
        return 'fsWrite';
    return 'other';
}
/** 该工具在当前权限下是否放行；返回 null 表示放行，返回能力组表示被该组拒绝。 */
export function deniedToolGroup(toolName, permission) {
    const name = String(toolName ?? '').trim();
    if (!name)
        return null;
    // 显式白名单：非空时只放行列出的工具（大小写不敏感），其余一律拒绝
    if (permission.toolAllow.length) {
        const listed = permission.toolAllow.some((item) => item.toLowerCase() === name.toLowerCase());
        if (listed)
            return null;
        return toolGroupOf(name) === 'other' ? 'other' : toolGroupOf(name);
    }
    const group = toolGroupOf(name);
    if (group === 'other')
        return null;
    if (group === 'fsWrite')
        return permission.caps.fsWrite ? null : 'fsWrite';
    if (group === 'exec')
        return permission.caps.exec ? null : 'exec';
    if (group === 'pluginManage')
        return permission.caps.pluginManage ? null : 'pluginManage';
    if (group === 'power')
        return permission.caps.power ? null : 'power';
    if (group === 'computerUse')
        return permission.caps.computerUse ? null : 'computerUse';
    return null;
}
/** 能力组的中文名（日志与界面共用）。 */
export const TOOL_GROUP_LABEL = {
    fsWrite: '写文件',
    exec: '执行命令',
    pluginManage: '插件管理',
    power: '电源操作',
    computerUse: '接管桌面',
    other: '其它',
};
/** 权限的一句话摘要（日志用）。 */
export function summarizePermission(permission) {
    if (!permission.bound)
        return '未绑定权限（拒绝）';
    const allowed = Object.keys(permission.caps).filter((key) => permission.caps[key]);
    return `${permission.ruleIds.join('/')}｜能力=${allowed.join(',') || '无'}｜沙箱=${permission.sandbox || '默认'}｜审批=${permission.approval || '默认'}`;
}
