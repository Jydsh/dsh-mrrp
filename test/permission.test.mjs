import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, DEFAULT_PERMISSIONS, sanitizeConfig, sanitizePermission, sanitizePermissions } from '../dist/store.js';
import {
  collectPermissionBindings,
  deniedToolGroup,
  resolveUserPermission,
  summarizePermission,
  toolGroupOf,
} from '../dist/permission.js';

/** 最小配置：用户 u1（部门 d1 + 角色 r1）、权限表用内置三条。 */
function makeConfig(overrides = {}) {
  return sanitizeConfig({
    ...DEFAULT_CONFIG,
    permissions: DEFAULT_PERMISSIONS.map((p) => ({ ...p, caps: { ...p.caps }, toolAllow: [] })),
    defaultPermissionId: '',
    roles: [{ id: 'role_r1', name: '部门角色', deptIds: [], categoryBindings: [], permissionIds: [], desc: '' }],
    depts: [{ id: 'dept_d1', name: '数智部', parentId: '', roleIds: ['role_r1'], permissionIds: [] }],
    users: [{ id: 'u1', name: '李鹏', roleId: '', deptIds: ['dept_d1'], permissionIds: [], note: '' }],
    ...overrides,
  });
}

test('内置权限三条：只读只有 chat，标准多了写文件与命令，管理员全开', () => {
  const readonly = DEFAULT_PERMISSIONS.find((p) => p.id === 'perm_readonly');
  const standard = DEFAULT_PERMISSIONS.find((p) => p.id === 'perm_standard');
  const admin = DEFAULT_PERMISSIONS.find((p) => p.id === 'perm_admin');
  assert.deepEqual(
    [readonly.caps.chat, readonly.caps.fsWrite, readonly.caps.exec, readonly.caps.pluginManage, readonly.caps.power, readonly.caps.computerUse],
    [true, false, false, false, false, false],
  );
  assert.deepEqual(
    [standard.caps.chat, standard.caps.fsWrite, standard.caps.exec, standard.caps.pluginManage, standard.caps.power],
    [true, true, true, false, false],
  );
  assert.equal(admin.caps.power, true);
  assert.equal(admin.caps.pluginManage, true);
  assert.equal(readonly.sandbox, 'read-only');
  assert.equal(admin.sandbox, 'danger-full-access');
});

test('未绑定权限且没配默认权限 = 直接拒绝', () => {
  const config = makeConfig();
  const perm = resolveUserPermission(config, 'u1');
  assert.equal(perm.bound, false);
  assert.equal(perm.caps.chat, false);
  assert.equal(summarizePermission(perm), '未绑定权限（拒绝）');
});

test('未绑定权限但配了默认权限 → 按默认权限放行（bound 标记为 true）', () => {
  const config = makeConfig({ defaultPermissionId: 'perm_standard' });
  const perm = resolveUserPermission(config, 'u1');
  assert.equal(perm.bound, true);
  assert.equal(perm.caps.exec, true);
  assert.equal(perm.sandbox, 'workspace-write');
  assert.deepEqual(perm.sources, ['默认权限']);
});

test('用户/角色/部门多处绑定取最严：管理员 + 只读 = 只读', () => {
  const config = makeConfig({
    users: [{ id: 'u1', name: '李鹏', roleId: 'role_r1', deptIds: ['dept_d1'], permissionIds: ['perm_admin'], note: '' }],
    roles: [{ id: 'role_r1', name: '部门角色', deptIds: [], categoryBindings: [], permissionIds: ['perm_readonly'], desc: '' }],
    depts: [{ id: 'dept_d1', name: '数智部', parentId: '', roleIds: ['role_r1'], permissionIds: [] }],
  });
  const { ids, sources } = collectPermissionBindings(config, 'u1');
  assert.deepEqual(ids.sort(), ['perm_admin', 'perm_readonly']);
  assert.deepEqual(sources, ['用户', '用户角色']);
  const perm = resolveUserPermission(config, 'u1');
  assert.equal(perm.bound, true);
  assert.equal(perm.caps.chat, true);
  assert.equal(perm.caps.exec, false);
  assert.equal(perm.caps.power, false);
  assert.equal(perm.sandbox, 'read-only');
  assert.equal(perm.approval, 'ask');
});

test('部门权限也被继承，并与用户权限取最严', () => {
  const config = makeConfig({
    users: [{ id: 'u1', name: '李鹏', roleId: '', deptIds: ['dept_d1'], permissionIds: ['perm_standard'], note: '' }],
    depts: [{ id: 'dept_d1', name: '数智部', parentId: '', roleIds: [], permissionIds: ['perm_readonly'] }],
  });
  const perm = resolveUserPermission(config, 'u1');
  assert.equal(perm.caps.fsWrite, false);
  assert.equal(perm.caps.exec, false);
  assert.deepEqual(perm.ruleIds.sort(), ['perm_readonly', 'perm_standard']);
  assert.ok(perm.sources.includes('部门 数智部'));
});

test('工具白名单：多条规则取交集，白名单非空时只放行列出的工具', () => {
  const config = makeConfig({
    users: [{ id: 'u1', name: '李鹏', roleId: '', deptIds: [], permissionIds: ['perm_readonly', 'perm_admin'], note: '' }],
    permissions: [
      { id: 'perm_readonly', name: '只读应答', desc: '', caps: { chat: true, fsWrite: false, exec: false, pluginManage: false, power: false, computerUse: false }, toolAllow: ['Read', 'Edit'], sandbox: 'read-only', approval: 'ask' },
      { id: 'perm_admin', name: '管理员', desc: '', caps: { chat: true, fsWrite: true, exec: true, pluginManage: true, power: true, computerUse: true }, toolAllow: ['Read', 'Bash'], sandbox: 'never-exists', approval: 'never' },
    ],
  });
  const perm = resolveUserPermission(config, 'u1');
  assert.deepEqual(perm.toolAllow, ['Read']);
  assert.equal(deniedToolGroup('Read', perm), null);
  assert.equal(deniedToolGroup('Bash', perm), 'exec');
  assert.notEqual(deniedToolGroup('Edit', perm), null);
  // 非法沙箱值被清洗为空，不参与合并 → 取到只读规则的 read-only
  assert.equal(perm.sandbox, 'read-only');
});

test('工具归类：命令/子agent 归 exec，写文件归 fsWrite，插件注册归 pluginManage，关机归 power', () => {
  assert.equal(toolGroupOf('bash'), 'exec');
  assert.equal(toolGroupOf('pwsh'), 'exec');
  assert.equal(toolGroupOf('run_command'), 'exec');
  assert.equal(toolGroupOf('delete_plugin'), 'pluginManage');
  assert.equal(toolGroupOf('shutdown'), 'power');
  assert.equal(toolGroupOf('write_file'), 'fsWrite');
  assert.equal(toolGroupOf('computer_use_tool'), 'computerUse');
  assert.equal(toolGroupOf('read_file'), 'other');
});

test('只有对话权限时，命令与关机工具都被拒（IM 越权的主闸门）', () => {
  const config = makeConfig({
    users: [{ id: 'u1', name: '李鹏', roleId: '', deptIds: [], permissionIds: ['perm_readonly'], note: '' }],
  });
  const perm = resolveUserPermission(config, 'u1');
  assert.equal(perm.bound, true);
  assert.equal(deniedToolGroup('bash', perm), 'exec');
  assert.equal(deniedToolGroup('shutdown_computer', perm), 'power');
  assert.equal(deniedToolGroup('write_file', perm), 'fsWrite');
  assert.equal(deniedToolGroup('read_file', perm), null);
});

test('sanitizePermissions：内置三条缺失时补回，自定义重复 id 去重', () => {
  const list = sanitizePermissions([
    { id: 'perm_custom', name: '自定义', caps: { chat: true, exec: true }, sandbox: 'danger-full-access', approval: 'never' },
    { id: 'perm_custom', name: '重复', caps: { chat: false } },
  ]);
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes('perm_custom'));
  assert.equal(ids.filter((id) => id === 'perm_custom').length, 1);
  assert.ok(ids.includes('perm_readonly'));
  assert.ok(ids.includes('perm_standard'));
  assert.ok(ids.includes('perm_admin'));
  // 未声明的能力开关按「关」处理（只信显式开启）
  const custom = list.find((p) => p.id === 'perm_custom');
  assert.equal(custom.caps.chat, true);
  assert.equal(custom.caps.fsWrite, false);
  assert.equal(custom.caps.power, false);
});

test('sanitizePermission 清洗非法沙箱/审批与超长工具名', () => {
  const rule = sanitizePermission({
    id: 'perm_x',
    name: '测试',
    caps: { chat: true, exec: 'yes' },
    toolAllow: ['bash', 'bash', 'x'.repeat(200), 123],
    sandbox: 'root',
    approval: 'always',
  });
  assert.equal(rule.id, 'perm_x');
  assert.equal(rule.caps.chat, true);
  assert.equal(rule.caps.exec, false); // 非布尔值按默认（关）
  assert.deepEqual(rule.toolAllow, ['bash']);
  assert.equal(rule.sandbox, '');
  assert.equal(rule.approval, '');
});

test('sanitizeConfig 默认带权限表且默认权限为空（未绑定即拒绝）', () => {
  const config = sanitizeConfig({});
  assert.equal(config.permissions.length >= 3, true);
  assert.equal(config.defaultPermissionId, '');
  assert.ok(config.permissions.some((p) => p.id === 'perm_admin'));
});
