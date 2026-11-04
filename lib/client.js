'use strict';
/* dsh-mrrp client bundle：MRRP 控制台（模型分类 / 角色部门 / 用户）。
   __ModuleLoader__ 格式，与 dsh-ding-card 的 client 打包方式一致。
   全部元素用 h()（React.createElement）手写，无 JSX。样式注入 <style>，跟随 DSH 浅色主题变量。 */
window.__ModuleLoader__.load({
  id: 'dsh-mrrp',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const PLUGIN_VERSION = '2026.11.04';
    const NAMESPACE = 'dsh-mrrp';
    const PANEL_ID = 'dsh-mrrp';
    const CHANNEL = 'mrrp';

    // 本插件的 RPC 通道：控制台所有读写都通过它，绝不触碰 DSH 主链路。
    async function rpcCall(ctx, method, payload = {}, signal) {
      const result = await ctx.connection.rpc.call('/api', CHANNEL, { method, payload }, signal);
      if (!result || typeof result.ok !== 'boolean') {
        throw new Error('无法访问 DSH 管理接口，请检查 DSH 连接后重试。');
      }
      if (!result.ok) {
        const error = new Error(result.error?.message ?? '操作失败，请稍后重试。');
        error.code = result.error?.code ?? 'operation-failed';
        throw error;
      }
      return result.value;
    }

    const zh = { MRRP: 'MRRP', '模型路由控制台': '模型路由控制台', '打开 MRRP': '打开 MRRP' };
    const en = { MRRP: 'MRRP', '模型路由控制台': 'Model Routing Console', '打开 MRRP': 'Open MRRP' };

    /* ============================== 图标（文本字符优先 + 已验证的纯背景 CSS 形状） ============================== */
    // 重要：DSH 宿主不渲染插件内联 SVG（钉卡片同款写法同样空白，现场截图证实宿主侧边栏钉卡片也无图标）。
    // 现场逐项验证结论：
    //   · 纯 background / box-shadow 画的 CSS 形状（+、三层、三横、人）→ 渲染正常；
    //   · 用 transform 旋转或 border 三角/描边画的形状（编辑铅笔、垃圾桶、关闭 ×、齿轮、箭头）→ 全部空白；
    //   · 特殊 Unicode 字形（⚙ ✎ ↻ ●）在宿主字体栈下同样渲染为空框（现场截图证实）。
    // 因此：能画成纯背景/阴影形状的保留 CSS；其余一律改用通用文本字符（× « » √ → ▼ ▶ ⌂ 均为
    // Windows 中文字体栈内字符），行内操作按钮直接用中文文字（编辑/删除/设置）。
    const ico = (cls, ch) => (p) => {
      const s = (p && p.size) || 16;
      return h('span', {
        className: 'mrrp-ico ' + cls,
        'aria-hidden': 'true',
        style: { width: s + 'px', height: s + 'px', fontSize: s + 'px', lineHeight: '1' },
      }, ch == null ? null : ch);
    };
    const IconX = ico('ico-x', '×');
    const IconPlus = ico('ico-plus');
    const IconSettings = ico('ico-settings');
    const IconCollapse = ico('ico-collapse', '«');
    const IconExpand = ico('ico-expand', '»');
    const IconChevronDown = ico('ico-down', '▼');
    const IconChevronRight = ico('ico-right', '▶');
    const IconCheck = ico('ico-check', '√');
    const IconSearch = ico('ico-search');
    const IconTrash = ico('ico-trash');
    const IconEdit = ico('ico-edit');
    const IconRefresh = ico('ico-refresh');
    const IconLink = ico('ico-link');
    const IconDot = ico('ico-dot');
    const IconNavCategories = ico('ico-navLayers');
    const IconNavRoles = ico('ico-navPerson');
    const IconNavUsers = ico('ico-navPerson');
    const IconNavRoute = ico('ico-navRoute');
    const IconNavDecision = ico('ico-navDecision');
    const IconNavModels = ico('ico-navList');
    const IconNavDept = ico('ico-navHome', '⌂');
    const IconNavLog = ico('ico-navList');

    /* ============================== 通用 UI 原语 ============================== */
    function Spinner({ size = 16 }) {
      return h('span', { className: 'mrrp-spinner', style: { width: size + 'px', height: size + 'px' } });
    }
    function Btn({ variant, size, disabled, onClick, title, className, children: propChildren }, extraChildren) {
      // 兼容两种调用形态：h(Btn, {..}, child) 走 props.children；直接 Btn({..}, child) 走第二实参。
      const children = propChildren !== undefined ? propChildren : extraChildren;
      const cls = ['mrrp-btn', variant && `mrrp-btn-${variant}`, size && `mrrp-btn-${size}`, className].filter(Boolean).join(' ');
      return h('button', { className: cls, disabled, onClick, title, type: 'button' }, children);
    }
    function IconBtn({ children: propChildren, onClick, title, disabled, danger }, extraChildren) {
      const children = propChildren !== undefined ? propChildren : extraChildren;
      const cls = ['mrrp-btn', 'mrrp-btn-icon', danger ? 'mrrp-btn-danger' : ''].filter(Boolean).join(' ');
      return h('button', { className: cls, onClick, title, disabled, type: 'button' }, children);
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'mrrp-field' },
        h('span', { className: 'mrrp-field-label' }, label),
        children,
        hint ? h('span', { className: 'mrrp-hint' }, hint) : null);
    }
    function Select({ value, onChange, options, placeholder, disabled, className }) {
      return h('select', {
        className: ['mrrp-select', className].filter(Boolean).join(' '),
        value, disabled,
        onChange: (e) => onChange && onChange(e.target.value),
      },
      placeholder ? h('option', { value: '' }, placeholder) : null,
      options.map((opt) => {
        if (typeof opt === 'string') return h('option', { key: opt, value: opt }, opt);
        return h('option', { key: opt.value, value: opt.value }, opt.label);
      }));
    }
    /* 可搜索下拉框（combobox）：点击展开为搜索输入，模糊匹配后点选；支持键盘上下 + Enter */
    function ModelSearchSelect({ value, onChange, options, placeholder, disabled }) {
      const [open, setOpen] = useState(false);
      const [q, setQ] = useState('');
      const [hl, setHl] = useState(0);
      const filtered = useMemo(() => {
        const needle = (q || '').trim().toLowerCase();
        if (!needle) return options;
        return options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(needle));
      }, [options, q]);
      const selected = options.find((o) => o.value === value);
      const close = () => { setOpen(false); setQ(''); };
      return h('div', {
        className: 'mrrp-combobox',
        tabIndex: -1,
        onBlur: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) close(); },
      },
        h('div', {
          className: 'mrrp-combobox-input',
          onClick: () => { if (disabled) return; setOpen(!open); setHl(0); },
        },
          open
            ? h('input', {
                className: 'mrrp-combobox-field',
                placeholder: '搜索模型名称 / ID / 提供方',
                value: q,
                autoFocus: true,
                onChange: (e) => { setQ(e.target.value); setHl(0); },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { if (filtered[hl]) { onChange(filtered[hl].value); close(); } }
                  else if (e.key === 'Escape') { close(); }
                  else if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) setHl(Math.min(hl + 1, filtered.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(Math.max(hl - 1, 0)); }
                },
              })
            : h('span', {
                className: ['mrrp-combobox-value', value ? '' : 'mrrp-combobox-placeholder'].filter(Boolean).join(' '),
              }, selected ? selected.label : (placeholder || '选择…')),
          h('span', { className: 'mrrp-combobox-arrow' }, open ? '▲' : '▼')),
        open ? h('div', { className: 'mrrp-combobox-panel' },
          filtered.length === 0
            ? h('div', { className: 'mrrp-combobox-empty' }, '没有匹配的模型')
            : filtered.map((o, i) => h('div', {
                key: o.value,
                className: ['mrrp-combobox-option', i === hl ? 'is-highlight' : '', o.value === value ? 'is-selected' : ''].filter(Boolean).join(' '),
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => { onChange(o.value); close(); },
              }, o.label))) : null);
    }
    function Toggle({ checked, onChange, label, desc, disabled }) {
      return h('label', { className: 'mrrp-toggle' },
        h('input', { type: 'checkbox', checked: !!checked, disabled, onChange: (e) => onChange && onChange(e.target.checked) }),
        h('span', { className: 'mrrp-toggle-track' }, h('span', { className: 'mrrp-toggle-thumb' })),
        (label || desc) ? h('span', { className: 'mrrp-toggle-text' },
          label ? h('span', {}, label) : null,
          desc ? h('small', {}, desc) : null) : null);
    }
    function Pill({ tone, children, title }) {
      return h('span', { className: `mrrp-pill${tone ? ` mrrp-pill-${tone}` : ''}`, title }, children);
    }
    function Empty({ icon, title, desc, children }) {
      return h('div', { className: 'mrrp-empty' },
        icon ? h('div', { className: 'mrrp-empty-icon' }, icon) : null,
        title ? h('div', { className: 'mrrp-empty-title' }, title) : null,
        desc ? h('div', { className: 'mrrp-empty-desc' }, desc) : null,
        children ? h('div', { className: 'mrrp-empty-action' }, children) : null);
    }
    function Card({ title, extra, children, className }) {
      return h('section', { className: ['mrrp-card', className].filter(Boolean).join(' ') },
        (title || extra) ? h('div', { className: 'mrrp-card-head' },
          title ? h('h3', {}, title) : h('span', {}),
          extra ? h('div', { className: 'mrrp-card-extra' }, extra) : null) : null,
        h('div', { className: 'mrrp-card-body' }, children));
    }
    function Modal({ title, onClose, children, footer, width = 460 }) {
      return h('div', { className: 'mrrp-modal-overlay', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose && onClose(); } },
        h('div', { className: 'mrrp-modal', style: { width } },
          h('div', { className: 'mrrp-modal-head' },
            h('h3', {}, title),
            IconBtn({ onClick: onClose, title: '关闭' }, h(IconX, { size: 16 }))),
          h('div', { className: 'mrrp-modal-body' }, children),
          footer ? h('div', { className: 'mrrp-modal-foot' }, footer) : null));
    }

    /* ============================== 数据工具 ============================== */
    function modelKey(m) { return m.key || `${m.provider}:${m.id}`; }
    function categoryOfModel(categories, key) {
      return (categories || []).find((c) => (c.modelIds || []).includes(key)) || null;
    }
    function clone(value) { return JSON.parse(JSON.stringify(value)); }

    /* ============================== Toast 系统 ============================== */
    function ToastStack({ toasts, onDismiss }) {
      return h('div', { className: 'mrrp-toasts' },
        (toasts || []).map((t) => h('div', { key: t.id, className: `mrrp-toast mrrp-toast-${t.tone || 'info'}` },
          h('span', { className: 'mrrp-toast-msg' }, t.message),
          IconBtn({ onClick: () => onDismiss(t.id), title: '关闭' }, h(IconX, { size: 14 })))));
    }

    /* ============================== 模型分类页 ============================== */
    /* ============================== 路由模型配置页 ============================== */
    const DECISION_FORMATS = [
      { value: 'laya', label: 'laya-server（本地决策模型）' },
      { value: 'openai', label: 'OpenAI 兼容' },
      { value: 'generic', label: '通用 API' },
    ];
    const DECISION_ENDPOINTS = [
      { value: 'systemone', label: '本地 laya-server（/v1/systemone）' },
      { value: 'decisions', label: '0G 云端（/v1/decisions）' },
    ];
    function decisionFormatLabel(format) {
      const item = DECISION_FORMATS.find((x) => x.value === format);
      return item ? item.label.split('（')[0] : format;
    }
    function layaEndpointLabel(p) {
      if (p.format !== 'laya') return '';
      return p.endpoint === 'decisions' ? '0G 云端' : '本地 laya-server';
    }
    function friendlyTestErr(message) {
      return /timeout|aborted/i.test(message || '') ? '连接超时：服务推理可能较忙或未响应，请稍后重试。' : message;
    }
    function catName(list, id) {
      if (!id) return '未绑定分类';
      const item = (list || []).find((c) => c.id === id);
      return item ? item.name : '未绑定分类';
    }

    function DecisionProviderModal({ ctx, initial, onClose, onSaved }) {
      const [p, setP] = useState(initial);
      const [busy, setBusy] = useState(false);
      const [line, setLine] = useState(null);
      const [newName, setNewName] = useState('');
      const set = (key, value) => setP({ ...p, [key]: value });
      const current = () => ({ ...p, name: (p.name || '').trim(), baseUrl: (p.baseUrl || '').trim() });
      const save = async () => {
        if (!p.name.trim()) { setLine({ tone: 'error', text: '请填写提供方名称。' }); return; }
        if (!p.baseUrl.trim()) { setLine({ tone: 'error', text: '请填写 API 地址。' }); return; }
        setBusy(true);
        try {
          await rpcCall(ctx, 'decision.save', { provider: current() });
          onSaved();
        } catch (error) { setLine({ tone: 'error', text: error.message }); setBusy(false); }
      };
      const test = async () => {
        if (!p.baseUrl.trim()) { setLine({ tone: 'error', text: '请先填写 API 地址。' }); return; }
        setBusy(true); setLine(null);
        try {
          const r = await rpcCall(ctx, 'decision.test', { provider: current() });
          setLine({ tone: r.ok ? 'ok' : 'error', text: r.ok ? `连接成功（${r.latencyMs} ms）` : friendlyTestErr(r.message) });
        } catch (error) { setLine({ tone: 'error', text: friendlyTestErr(error.message) }); }
        finally { setBusy(false); }
      };
      const fetchNames = async () => {
        if (!p.baseUrl.trim()) { setLine({ tone: 'error', text: '请先填写 API 地址。' }); return; }
        setBusy(true); setLine(null);
        try {
          const r = await rpcCall(ctx, 'decision.fetch', { provider: current() });
          const names = (r.models || []).map((m) => m.id);
          setP({ ...p, modelNames: Array.from(new Set([...(p.modelNames || []), ...names])) });
          setLine({ tone: 'ok', text: r.manual ? '已填入 laya-server 内置模型名。' : `拉取到 ${names.length} 个模型。` });
        } catch (error) { setLine({ tone: 'error', text: error.message }); }
        finally { setBusy(false); }
      };
      const addName = () => {
        const t = newName.trim();
        if (!t) return;
        setP({ ...p, modelNames: Array.from(new Set([...(p.modelNames || []), t])) });
        setNewName('');
      };
      const removeName = (name) => setP({ ...p, modelNames: (p.modelNames || []).filter((x) => x !== name) });
      return h(Modal, {
        title: initial && initial.id ? '编辑决策模型提供方' : '新增决策模型提供方', onClose, width: 520,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose, disabled: busy }, '取消'),
          h(Btn, { onClick: test, disabled: busy }, busy ? h(Spinner, {}) : '测试连接'),
          h(Btn, { variant: 'primary', onClick: save, disabled: busy }, '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '提供方名称' }, h('input', { className: 'mrrp-input', value: p.name, autoFocus: true, onChange: (e) => set('name', e.target.value) })),
        h(Field, { label: '接口格式' }, h(Select, { value: p.format, options: DECISION_FORMATS, onChange: (v) => set('format', v) })),
        (p.format === 'laya') ? h(Field, { label: '调用端点', hint: '本地 laya-server 走 {地址}/v1/systemone；0G 云端走 {地址}/v1/decisions 并自动带 model: laya' },
          h(Select, { value: p.endpoint || 'systemone', options: DECISION_ENDPOINTS, onChange: (v) => set('endpoint', v) })) : null,
        h(Field, { label: 'API 地址', hint: p.format === 'laya' ? (p.endpoint === 'decisions' ? '0G 云端基地址，如 https://router-api.0g.ai' : 'laya-server 基地址，决策调用走 {地址}/v1/systemone，如 http://127.0.0.1:8000') : 'OpenAI 兼容走 {地址}/v1/models，通用 API 走 {地址}/models' },
          h('input', { className: 'mrrp-input', value: p.baseUrl, placeholder: p.format === 'laya' && p.endpoint === 'decisions' ? 'https://router-api.0g.ai' : 'http://127.0.0.1:8000', onChange: (e) => set('baseUrl', e.target.value) })),
        h(Field, { label: 'API 密钥', hint: '选填；服务端未设置密钥（如 LAYA_API_KEY 未启用）时留空' },
          h('input', { type: 'password', className: 'mrrp-input', value: p.apiKey, placeholder: 'Bearer 密钥，可留空', onChange: (e) => set('apiKey', e.target.value) })),
        h(Field, { label: '模型列表', hint: p.format === 'laya' ? '无模型列表接口，手动输入检查点名称（english / multilingual / typed-decisions）' : '点击「获取模型」从服务端拉取，可再手动增删' },
          h('div', { className: 'mrrp-modelChips' },
            (p.modelNames || []).map((n) => h('span', { key: n, className: 'mrrp-chip' }, n, h('button', { type: 'button', onClick: () => removeName(n) }, '×')))),
          h('div', { className: 'mrrp-modelAdd' },
            h('input', { className: 'mrrp-bindSearch', value: newName, placeholder: '输入模型名，回车添加', onChange: (e) => setNewName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } } }),
            h(Btn, { size: 'small', onClick: addName }, '添加'),
            h(Btn, { size: 'small', onClick: fetchNames, disabled: busy }, p.format === 'laya' ? '填入内置模型名' : '获取模型'))),
        h(Field, { label: '启用', hint: '关闭后 laya_decide 工具不再使用该提供方' },
          h(Toggle, { checked: !!p.enabled, onChange: (v) => set('enabled', v) })),
        line ? h('div', { className: `mrrp-testLine mrrp-test-${line.tone}` }, line.text) : null));
    }

    function RouteConfigPage({ ctx, notify }) {
      const [route, setRoute] = useState(null);
      const [providers, setProviders] = useState([]);
      const [models, setModels] = useState([]);
      const [busy, setBusy] = useState(false);

      async function reload() {
        setBusy(true);
        try {
          const routeR = await rpcCall(ctx, 'route.get', {});
          setRoute(routeR.route);
        } catch (error) { notify(error.message, 'error'); }
        // 模型 / 提供方加载失败时降级为空，不影响路由配置本身
        try {
          const [decR, modelR] = await Promise.all([
            rpcCall(ctx, 'decision.list', {}),
            rpcCall(ctx, 'models.list', {}),
          ]);
          setProviders(decR.providers || []);
          setModels(modelR.models || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function saveRoute() {
        if (!route) return;
        try {
          await rpcCall(ctx, 'route.save', { route });
          notify('路由配置已保存', 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      const patchIm = (patch) => setRoute({ ...route, imRoute: { ...route.imRoute, ...patch } });

      const providerOptions = providers.map((p) => ({
        value: p.id,
        label: `${p.name}（${decisionFormatLabel(p.format)}${p.endpoint ? ' · ' + p.endpoint : ''}${p.enabled ? '' : ' · 已停用'}）`,
      }));
      const allModelOptions = models.map((m) => ({ value: m.key, label: `${m.key}（${m.name}）` }));

      return h('div', { className: 'mrrp-section mrrp-singleCard' },
        h(Card, {
          title: '决策模型路由',
          extra: h('span', { className: 'mrrp-card-sub' }, route?.imRoute?.enabled ? '决策模型运行中' : '未启动'),
        },
        route ? [
          h('div', { className: 'mrrp-imRouteDesc' },
            '启动后：本插件向 DSH 对话暴露一个虚拟模型「MRRP 智能路由」。对话选中该模型后，插件按会话发送者匹配用户表 → 取用户（单独角色 + 所属部门角色）绑定的模型分类并去重 → 候选多个时用内置判定问题请 Laya 决策模型选一个 → 由该真实模型生成回复。'),
          h('div', { className: 'mrrp-formToggles' },
            h(Toggle, { label: '启动决策模型', desc: '打开后 dsh-im / DSH 对话的模型列表会出现「MRRP 智能路由」，选中即按用户权限路由真实模型回复', checked: route.imRoute.enabled, onChange: (v) => patchIm({ enabled: v }) })),
          h('div', { className: 'mrrp-formGrid' },
            h(Field, { label: '决策模型（Laya）', hint: '仅支持 format=laya 的提供方（本地 systemone / 0G decisions）；候选模型的选择判定由插件内置，无需配置' },
              h(Select, { value: route.imRoute.decisionProviderId, onChange: (v) => patchIm({ decisionProviderId: v }), options: providerOptions, placeholder: '选择决策模型提供方' })),
            h(Field, { label: '兜底模型', hint: '用户未注册 / 未绑定分类 / 决策失败时使用的模型（provider:id）' },
              h(ModelSearchSelect, { value: route.imRoute.fallbackModel, onChange: (v) => patchIm({ fallbackModel: v }), options: allModelOptions, placeholder: '搜索并选择兜底模型' })),
            h(Field, { label: '未注册用户', hint: '消息发送者不在用户表时的处理' },
              h(Select, { value: route.imRoute.unknownUser, onChange: (v) => patchIm({ unknownUser: v }), options: [
                { value: 'ignore', label: '不路由（对话明确提示未注册）' },
                { value: 'fallback', label: '使用兜底模型' },
              ] })),
            h(Field, { label: '渠道', hint: '允许路由的 dsh-im 渠道，逗号分隔（默认 dingtalk；空 = 全部）' },
              h('input', { className: 'mrrp-input', value: (route.imRoute.channels || []).join(','), onChange: (e) => patchIm({ channels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) })),
          ),
          h('div', { className: 'mrrp-card-foot' },
            h(Btn, { variant: 'primary', onClick: saveRoute, disabled: busy }, h(IconCheck, { size: 14 }), '保存路由配置')),
        ] : h(Spinner, { size: 20 })));
    }

    /* ============================== 决策模型配置页 ============================== */
    function DecisionConfigPage({ ctx, notify }) {
      const [providers, setProviders] = useState([]);
      const [catList, setCatList] = useState([]);
      const [editing, setEditing] = useState(null);
      const [working, setWorking] = useState('');

      async function reload() {
        try {
          const [decR, catR] = await Promise.all([
            rpcCall(ctx, 'decision.list', {}),
            rpcCall(ctx, 'categories.list', {}),
          ]);
          setProviders(decR.providers || []);
          setCatList(catR.categories || []);
        } catch (error) { notify(error.message, 'error'); }
      }
      useEffect(() => { reload(); }, []);

      async function doTest(provider) {
        setWorking(provider.id + ':test');
        try {
          const r = await rpcCall(ctx, 'decision.test', { provider });
          notify(r.ok ? `「${provider.name}」连接成功（${r.latencyMs} ms）` : `「${provider.name}」连接失败：${friendlyTestErr(r.message)}`, r.ok ? 'success' : 'error');
        } catch (error) { notify(friendlyTestErr(error.message), 'error'); }
        finally { setWorking(''); }
      }
      async function doFetch(provider) {
        setWorking(provider.id + ':fetch');
        try {
          const r = await rpcCall(ctx, 'decision.fetch', { provider });
          const names = (r.models || []).map((m) => m.id);
          await rpcCall(ctx, 'decision.save', { provider: { ...provider, modelNames: Array.from(new Set([...(provider.modelNames || []), ...names])) } });
          notify(r.manual ? `已填入内置模型名（${names.length} 个）` : `已拉取并保存 ${names.length} 个模型`, 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
        finally { setWorking(''); }
      }
      async function doDelete(provider) {
        try {
          await rpcCall(ctx, 'decision.delete', { id: provider.id });
          notify(`已删除「${provider.name}」`, 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      return h('div', { className: 'mrrp-section mrrp-singleCard' },
        h(Card, {
          title: '决策模型配置',
          extra: h('div', { className: 'mrrp-card-head' },
            h('span', { className: 'mrrp-card-sub' }, `${providers.length} 个提供方`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setEditing({ id: '', name: '', format: 'laya', endpoint: 'systemone', baseUrl: '', apiKey: '', modelNames: [], categoryId: '', enabled: true }) }, '新增提供方')),
        },
        providers.length === 0
          ? h('div', { className: 'mrrp-bindEmpty' }, '尚未配置决策模型提供方。点击「新增提供方」接入 laya-server 或 OpenAI 兼容接口。')
          : h('div', { className: 'mrrp-providerList' },
            providers.map((p) => h('div', { key: p.id, className: 'mrrp-providerCard' },
              h('div', { className: 'mrrp-providerHead' },
                h('span', { className: 'mrrp-providerName' }, p.name),
                h('span', { className: `mrrp-formatBadge mrrp-format-${p.format}` }, decisionFormatLabel(p.format)),
                h('span', { className: 'mrrp-providerState' }, p.enabled ? '已启用' : '已停用'),
                h('div', { className: 'mrrp-providerActions' },
                  h(Btn, { size: 'small', disabled: working === p.id + ':test', onClick: () => doTest(p) }, working === p.id + ':test' ? h(Spinner, {}) : '测试'),
                  h(Btn, { size: 'small', disabled: working === p.id + ':fetch', onClick: () => doFetch(p) }, p.format === 'laya' ? '填内置名' : '获取模型'),
                  h(Btn, { size: 'small', onClick: () => setEditing(clone(p)) }, '编辑'),
                  h(Btn, { size: 'small', onClick: () => doDelete(p) }, '删除'))),
              h('div', { className: 'mrrp-providerMeta' },
                h('span', { title: p.baseUrl }, p.baseUrl || '未填写地址'),
                h('span', {}, p.apiKey ? '密钥已设置' : '无密钥'),
                layaEndpointLabel(p) ? h('span', {}, layaEndpointLabel(p)) : null,
                h('span', {}, catName(catList, p.categoryId))),
              (p.modelNames && p.modelNames.length)
                ? h('div', { className: 'mrrp-modelChips' }, p.modelNames.map((n) => h('span', { key: n, className: 'mrrp-chip' }, n)))
                : h('span', { className: 'mrrp-hint' }, '未配置模型名'))))),
        editing ? h(DecisionProviderModal, {
          ctx, initial: editing,
          onClose: () => setEditing(null),
          onSaved: async () => { setEditing(null); notify('决策模型提供方已保存', 'success'); await reload(); },
        }) : null);
    }

    /* ============================== 模型分类配置页 ============================== */
    function CategoryConfigPage({ ctx, notify }) {
      const [categories, setCategories] = useState([]);
      const [selectedCat, setSelectedCat] = useState(null);
      const [busy, setBusy] = useState(false);
      const [creating, setCreating] = useState(false);
      const [editingCat, setEditingCat] = useState(null);
      const [deletingCat, setDeletingCat] = useState(null);

      async function reload() {
        setBusy(true);
        try {
          const catR = await rpcCall(ctx, 'categories.list', {});
          setCategories(catR.categories || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);
      useEffect(() => { if (!selectedCat && categories.length) setSelectedCat(categories[0].id); }, [categories]);

      async function createCategory(name, desc, modelIds) {
        if (!name.trim()) { notify('请输入分类名称', 'error'); return false; }
        try {
          const res = await rpcCall(ctx, 'categories.create', { name: name.trim(), desc: desc.trim(), isDefault: false });
          const created = res && res.category;
          const ids = modelIds || [];
          if (created && created.id && ids.length) {
            await rpcCall(ctx, 'categories.bind', { id: created.id, modelIds: ids });
          }
          notify(`已创建分类「${name.trim()}」`, 'success');
          await reload();
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }
      async function updateCategory(cat, modelIds) {
        if (!cat.name.trim()) { notify('请输入分类名称', 'error'); return false; }
        try {
          await rpcCall(ctx, 'categories.update', { id: cat.id, name: cat.name.trim(), desc: cat.desc.trim() });
          const prev = cat.modelIds || [];
          const next = modelIds || [];
          const toAdd = next.filter((k) => !prev.includes(k));
          const toRemove = prev.filter((k) => !next.includes(k));
          if (toAdd.length) await rpcCall(ctx, 'categories.bind', { id: cat.id, modelIds: toAdd });
          if (toRemove.length) await rpcCall(ctx, 'categories.unbind', { id: cat.id, modelIds: toRemove });
          notify('分类已更新', 'success');
          await reload();
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }
      async function deleteCategory(id) {
        if (categories.length <= 1) { notify('至少保留一个模型分类，无法删除最后一个分类。', 'error'); setDeletingCat(null); return; }
        try {
          await rpcCall(ctx, 'categories.delete', { id });
          notify('分类已删除', 'success');
          setDeletingCat(null);
          setSelectedCat(null);
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      const selCat = categories.find((c) => c.id === selectedCat) || null;

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '模型分类配置',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${categories.length} 个分类`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreating(true) }, h(IconPlus, { size: 14 }), '新建分类')),
        },
        categories.length === 0
          ? h(Empty, { title: '还没有模型分类', desc: '创建一个分类，再把模型绑定进去。', icon: h(IconNavCategories, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreating(true) }, '新建分类'))
          : h('div', { className: 'mrrp-catList' },
            categories.map((cat) => {
              const active = cat.id === selCat?.id;
              return h('div', {
                key: cat.id, className: `mrrp-catItem${active ? ' is-active' : ''}`,
                onClick: () => setSelectedCat(cat.id),
              },
              h('div', { className: 'mrrp-catItem-main' },
                h('div', { className: 'mrrp-catItem-title' },
                  h('span', { className: 'mrrp-catItem-name' }, cat.name),
                  cat.isDefault ? h(Pill, { tone: 'info' }, '默认') : null,
                  h(Pill, {}, `${(cat.modelIds || []).length} 个模型`)),
                cat.desc ? h('div', { className: 'mrrp-catItem-desc' }, cat.desc) : null),
              h('div', { className: 'mrrp-catItem-actions' },
                Btn({ size: 'small', onClick: (e) => { e.stopPropagation(); setEditingCat(clone(cat)); }, title: '编辑' }, '编辑'),
                Btn({ size: 'small', variant: 'danger', onClick: (e) => { e.stopPropagation(); setDeletingCat(cat); }, title: '删除' }, '删除')));
            }))),
        creating ? h(CreateCategoryModal, {
          ctx,
          onClose: () => setCreating(false),
          onCreate: async (name, desc, modelIds) => { const ok = await createCategory(name, desc, modelIds); if (ok) setCreating(false); },
        }) : null,
        editingCat ? h(EditCategoryModal, {
          ctx,
          cat: editingCat,
          onClose: () => setEditingCat(null),
          onSave: async (cat, modelIds) => { const ok = await updateCategory(cat, modelIds); if (ok) setEditingCat(null); },
        }) : null,
        deletingCat ? h(Modal, {
          title: '删除分类', onClose: () => setDeletingCat(null), width: 380,
          footer: h('div', { className: 'mrrp-modal-actions' },
            h(Btn, { onClick: () => setDeletingCat(null) }, '取消'),
            h(Btn, { variant: 'danger', onClick: () => deleteCategory(deletingCat.id) }, '删除')),
        },
        h('p', { className: 'mrrp-modal-text' },
          `确定删除分类「${deletingCat.name}」？其绑定模型将被释放为未分类，依赖它的角色将改为走全局路由。`)) : null);
    }

    /* ============================== 模型列表页 ============================== */
    function ModelListPage({ ctx, notify }) {
      const [models, setModels] = useState([]);
      const [categories, setCategories] = useState([]);
      const [profiles, setProfiles] = useState({});
      const [drafts, setDrafts] = useState({});
      const [busy, setBusy] = useState(false);
      const [search, setSearch] = useState('');

      async function reload() {
        setBusy(true);
        try {
          const [modelR, catR, profR] = await Promise.all([
            rpcCall(ctx, 'models.list', {}),
            rpcCall(ctx, 'categories.list', {}),
            rpcCall(ctx, 'modelProfile.list', {}),
          ]);
          setModels(modelR.models || []);
          setCategories(catR.categories || []);
          setProfiles(profR.profiles || {});
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      const filteredModels = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return models;
        return models.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q));
      }, [models, search]);

      async function refreshModels() {
        setBusy(true);
        try {
          const modelR = await rpcCall(ctx, 'models.list', {});
          setModels(modelR.models || []);
          notify('模型列表已刷新', 'success');
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }

      async function bindModel(key, catId) {
        try {
          if (catId === '') {
            const current = categoryOfModel(categories, key);
            if (current) await rpcCall(ctx, 'categories.unbind', { id: current.id, modelIds: [key] });
            else { notify('该模型未绑定分类', 'info'); return; }
          } else {
            await rpcCall(ctx, 'categories.bind', { id: catId, modelIds: [key] });
          }
          notify('模型绑定已更新', 'success');
          await reload();
        } catch (error) { notify(error.message, 'error'); }
      }

      const PROFILE_TYPES = ['', '推理', '对话', '代码', '视觉', '长文本', '多模态', '工具调用', '快速', '其他'];
      async function saveProfile(key, type, scene) {
        try {
          const r = await rpcCall(ctx, 'modelProfile.set', { key, type, scene });
          setProfiles(r.profiles || {});
          const next = { ...drafts }; delete next[key]; setDrafts(next);
          notify(type || scene ? '模型画像已保存' : '已清除模型画像（回退分类画像）', 'success');
        } catch (error) { notify(error.message, 'error'); }
      }

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '模型列表',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${models.length} 个已发现模型`),
            h('div', { className: 'mrrp-search' }, h('input', { className: 'mrrp-search-input', placeholder: '搜索模型', value: search, onChange: (e) => setSearch(e.target.value) })),
            h(Btn, { size: 'small', onClick: refreshModels, disabled: busy }, '刷新')),
        },
        models.length === 0
          ? h(Empty, { title: '没有发现模型', desc: 'DSH 中尚未绑定任何模型，或当前运行时不提供模型发现接口。', icon: h(IconNavModels, { size: 22 }) },
              h(Btn, { size: 'small', onClick: refreshModels, disabled: busy }, '重新扫描'))
          : h('div', { className: 'mrrp-tableWrap' },
            h('table', { className: 'mrrp-table' },
              h('thead', null, h('tr', null,
                h('th', null, '模型'),
                h('th', null, '提供方'),
                h('th', null, '当前分类'),
                h('th', null, '类型 / 擅长场景'),
                h('th', { className: 'is-right' }, '绑定分类'))),
              h('tbody', null,
                filteredModels.map((m) => {
                  const key = modelKey(m);
                  const cat = categoryOfModel(categories, key);
                  const draft = drafts[key];
                  const profile = profiles[key] || { type: '', scene: '' };
                  const curType = draft ? draft.type : profile.type;
                  const curScene = draft ? draft.scene : profile.scene;
                  const setDraft = (patch) => setDrafts((prev) => ({ ...prev, [key]: { ...(draft || profile), ...patch } }));
                  return h('tr', { key },
                    h('td', null, h('div', { className: 'mrrp-modelCell' },
                      h('span', { className: 'mrrp-modelName' }, m.name),
                      h('span', { className: 'mrrp-modelId' }, m.id))),
                    h('td', null, h(Pill, {}, m.provider)),
                    h('td', null, cat ? h(Pill, { tone: 'brand' }, cat.name) : h('span', { className: 'mrrp-muted' }, '未分类')),
                    h('td', null, h('div', { className: 'mrrp-profileCell' },
                      h(Select, {
                        className: 'mrrp-bindSelect',
                        value: curType,
                        onChange: (v) => setDraft({ type: v }),
                        options: PROFILE_TYPES.map((t) => ({ value: t, label: t || '不设置' })),
                      }),
                      h('input', {
                        className: 'mrrp-profileScene',
                        placeholder: '擅长场景（可选）',
                        value: curScene,
                        onChange: (e) => setDraft({ scene: e.target.value }),
                      }),
                      h(Btn, { size: 'small', onClick: () => saveProfile(key, curType, curScene) }, '保存'))),
                    h('td', { className: 'is-right' },
                      h('div', { className: 'mrrp-bindCell' },
                        h(Select, {
                          className: 'mrrp-bindSelect',
                          value: cat ? cat.id : '',
                          onChange: (v) => bindModel(key, v),
                          options: [{ value: '', label: '未分类' }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
                        }),
                        h('span', { className: 'mrrp-linkHint', title: '绑定到分类' }))))
                }))))));
    }

    /* 绑定模型选择器：搜索 + 分页，避免一次渲染全部模型 */
    function ModelBindPicker({ ctx, value, onChange }) {
      const PAGE_SIZE = 12;
      const [models, setModels] = useState([]);
      const [q, setQ] = useState('');
      const [page, setPage] = useState(0);
      useEffect(() => { (async () => {
        try {
          const r = await rpcCall(ctx, 'models.list', {});
          setModels(r.models || []);
        } catch (e) { setModels([]); }
      })(); }, []);
      const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        if (!s) return models;
        return models.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(s));
      }, [models, q]);
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const cur = Math.min(page, totalPages - 1);
      const pageModels = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
      const toggle = (key) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
      const togglePageAll = () => {
        const keys = pageModels.map(modelKey);
        const allOn = keys.length > 0 && keys.every((k) => value.includes(k));
        onChange(allOn ? value.filter((k) => !keys.includes(k)) : Array.from(new Set([...value, ...keys])));
      };
      return h('div', { className: 'mrrp-bindPanel' },
        h('div', { className: 'mrrp-bindHead' },
          h('input', { className: 'mrrp-bindSearch', placeholder: '搜索模型名称 / ID / 提供方', value: q, onChange: (e) => { setQ(e.target.value); setPage(0); } }),
          h('span', { className: 'mrrp-bindCount' }, `已选 ${value.length} 个`)),
        models.length === 0
          ? h('div', { className: 'mrrp-bindEmpty' }, '暂未发现模型，可到「模型列表」页刷新')
          : pageModels.length === 0
            ? h('div', { className: 'mrrp-bindEmpty' }, '没有匹配的模型')
            : h('div', { className: 'mrrp-bindBody' },
              h('div', { className: 'mrrp-bindGrid' },
                pageModels.map((m) => {
                  const key = modelKey(m);
                  const checked = value.includes(key);
                  return h('label', { key, className: `mrrp-bindItem${checked ? ' is-checked' : ''}` },
                    h('input', { type: 'checkbox', checked, onChange: () => toggle(key) }),
                    h('span', { className: 'mrrp-bindMeta' }, h('span', {}, m.name), h('small', {}, m.provider)));
                }))),
        h('div', { className: 'mrrp-bindFoot' },
          h('span', { className: 'mrrp-bindMuted' }, `共 ${filtered.length} 个模型`),
          h('div', { className: 'mrrp-bindPages' },
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur === 0, onClick: () => setPage(cur - 1) }, '«'),
            h('span', { className: 'mrrp-bindPageNo' }, `${cur + 1} / ${totalPages}`),
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur >= totalPages - 1, onClick: () => setPage(cur + 1) }, '»'),
            h('button', { type: 'button', className: 'mrrp-bindNav mrrp-bindAll', disabled: pageModels.length === 0, onClick: togglePageAll }, '全选本页'))));
    }

    /* 通用「搜索 + 分页 + 全选本页」绑定面板：部门 / 角色 / 分类 / 模型均可复用。
       items: [{ key, label, sub? }]；selected: string[]；onChange(newSelected)。 */
    function PickPanel({ items, selected, onChange, searchOf, placeholder, emptyText }) {
      const PAGE_SIZE = 12;
      const [q, setQ] = useState('');
      const [page, setPage] = useState(0);
      const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        if (!s) return items;
        return items.filter((it) => searchOf(it).toLowerCase().includes(s));
      }, [items, q]);
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const cur = Math.min(page, totalPages - 1);
      const pageItems = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
      const toggle = (key) => onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
      const togglePageAll = () => {
        const keys = pageItems.map((it) => it.key);
        const allOn = keys.length > 0 && keys.every((k) => selected.includes(k));
        onChange(allOn ? selected.filter((k) => !keys.includes(k)) : Array.from(new Set([...selected, ...keys])));
      };
      return h('div', { className: 'mrrp-bindPanel' },
        h('div', { className: 'mrrp-bindHead' },
          h('input', { className: 'mrrp-bindSearch', placeholder, value: q, onChange: (e) => { setQ(e.target.value); setPage(0); } }),
          h('span', { className: 'mrrp-bindCount' }, `已选 ${selected.length} 个`)),
        items.length === 0
          ? h('div', { className: 'mrrp-bindEmpty' }, emptyText)
          : pageItems.length === 0
            ? h('div', { className: 'mrrp-bindEmpty' }, '没有匹配项')
            : h('div', { className: 'mrrp-bindBody' },
              h('div', { className: 'mrrp-bindGrid' },
                pageItems.map((it) => {
                  const checked = selected.includes(it.key);
                  return h('label', { key: it.key, className: `mrrp-bindItem${checked ? ' is-checked' : ''}` },
                    h('input', { type: 'checkbox', checked, onChange: () => toggle(it.key) }),
                    h('span', { className: 'mrrp-bindMeta' }, h('span', {}, it.label), it.sub ? h('small', {}, it.sub) : null));
                }))),
        h('div', { className: 'mrrp-bindFoot' },
          h('span', { className: 'mrrp-bindMuted' }, `共 ${filtered.length} 项`),
          h('div', { className: 'mrrp-bindPages' },
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur === 0, onClick: () => setPage(cur - 1) }, '«'),
            h('span', { className: 'mrrp-bindPageNo' }, `${cur + 1} / ${totalPages}`),
            h('button', { type: 'button', className: 'mrrp-bindNav', disabled: cur >= totalPages - 1, onClick: () => setPage(cur + 1) }, '»'),
            h('button', { type: 'button', className: 'mrrp-bindNav mrrp-bindAll', disabled: pageItems.length === 0, onClick: togglePageAll }, '全选本页'))));
    }

    function CreateCategoryModal({ ctx, onClose, onCreate }) {
      const [name, setName] = useState('');
      const [desc, setDesc] = useState('');
      const [sel, setSel] = useState([]);
      const [saving, setSaving] = useState(false);
      return h(Modal, {
        title: '新建分类', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onCreate(name, desc, sel); setSaving(false); } }, saving ? h(Spinner, {}) : '创建')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '分类名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '用途说明', hint: '说明这个分类适合什么任务' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) })),
        h(Field, { label: '绑定模型', hint: '支持搜索与分页，可稍后在「模型列表」页调整' },
          h(ModelBindPicker, { ctx, value: sel, onChange: setSel }))));
    }

    function EditCategoryModal({ ctx, cat, onClose, onSave }) {
      const [name, setName] = useState(cat.name);
      const [desc, setDesc] = useState(cat.desc || '');
      const [sel, setSel] = useState(cat.modelIds || []);
      const [saving, setSaving] = useState(false);
      return h(Modal, {
        title: '编辑分类', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onSave({ id: cat.id, name, desc, modelIds: cat.modelIds || [] }, sel); setSaving(false); } }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '分类名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '用途说明' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) })),
        h(Field, { label: '绑定模型', hint: '支持搜索与分页，可稍后在「模型列表」页调整' },
          h(ModelBindPicker, { ctx, value: sel, onChange: setSel }))));
    }

    /* ============================== 角色 / 部门页 ============================== */
    /* ============================== 角色页 ============================== */
    function RolePage({ ctx, notify }) {
      const [roles, setRoles] = useState([]);
      const [depts, setDepts] = useState([]);
      const [categories, setCategories] = useState([]);
      const [busy, setBusy] = useState(false);
      const [creatingRole, setCreatingRole] = useState(false);
      const [editingRole, setEditingRole] = useState(null);
      const [defRoleId, setDefRoleId] = useState('');

      async function reload() {
        setBusy(true);
        try {
          const [roleR, deptR, catR, defR] = await Promise.all([
            rpcCall(ctx, 'roles.list', {}),
            rpcCall(ctx, 'depts.list', {}),
            rpcCall(ctx, 'categories.list', {}),
            rpcCall(ctx, 'userDefaults.get', {}),
          ]);
          setRoles(roleR.roles || []);
          setDepts(deptR.depts || []);
          setCategories(catR.categories || []);
          setDefRoleId(defR.roleId || '');
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function setDefaultRole(role) {
        // 校验：已存在其他默认角色时自动切换（保证全局只有一个默认角色）
        try {
          const r = await rpcCall(ctx, 'userDefaults.set', { roleId: role.id });
          setDefRoleId(r.roleId || '');
          if (r.previousRoleId && r.previousRoleId !== role.id) {
            const prev = roles.find((x) => x.id === r.previousRoleId);
            notify(`默认角色已从「${prev ? prev.name : r.previousRoleId}」切换为「${role.name}」`, 'success');
          } else {
            notify(`已将「${role.name}」设为自动添加默认角色`, 'success');
          }
        } catch (error) { notify(error.message, 'error'); }
      }

      async function saveRoles(next) {
        try {
          const r = await rpcCall(ctx, 'roles.save', { roles: next });
          setRoles(r.roles || next);
          if (r.depts) setDepts(r.depts);
          notify('角色已保存', 'success');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }

      const roleCategory = (id) => categories.find((c) => c.id === id) || null;

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '角色',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${roles.length} 个角色`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreatingRole(true) }, h(IconPlus, { size: 14 }), '新建角色')),
        },
        roles.length === 0
          ? h(Empty, { title: '还没有角色', desc: '角色决定请求走哪个模型分类，并绑定生效的部门。', icon: h(IconNavRoles, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreatingRole(true) }, '新建角色'))
          : h('div', { className: 'mrrp-roleList' },
            roles.map((role) => {
              const bindings = role.categoryBindings || [];
              return h('div', { key: role.id, className: 'mrrp-roleItem' },
                h('div', { className: 'mrrp-roleItem-main' },
                  h('div', { className: 'mrrp-roleItem-name' }, role.name),
                  h('div', { className: 'mrrp-roleItem-meta' },
                    ...bindings.map((b) => {
                      const cat = roleCategory(b.categoryId);
                      return cat ? h(Pill, { key: b.categoryId, tone: 'brand' }, `${cat.name} · ${(b.modelIds || []).length} 模型`) : null;
                    }),
                    bindings.length === 0 ? h(Pill, { tone: 'muted' }, '未绑定分类') : null,
                    role.deptIds && role.deptIds.length
                      ? h(Pill, {}, `绑定 ${role.deptIds.length} 个部门`)
                      : h(Pill, {}, '全局生效')),
                  role.desc ? h('div', { className: 'mrrp-roleItem-desc' }, role.desc) : null),
                h('div', { className: 'mrrp-roleItem-actions' },
                  defRoleId === role.id
                    ? h('span', { className: 'mrrp-defaultTag', title: 'dsh-im 自动添加的新用户默认绑定此角色' }, '默认角色')
                    : Btn({ size: 'small', onClick: () => setDefaultRole(role), title: '设为自动添加新用户的默认角色' }, '设为默认'),
                  Btn({ size: 'small', onClick: () => setEditingRole(clone(role)), title: '编辑' }, '编辑'),
                  Btn({ size: 'small', variant: 'danger', onClick: async () => {
                    if (defRoleId === role.id) { notify('请先取消该角色的默认标记（先设置其他角色为默认）', 'error'); return; }
                    const next = roles.filter((r) => r.id !== role.id); if (await saveRoles(next)) notify('角色已删除', 'success');
                  }, title: '删除' }, '删除')));
            }))),
        (creatingRole || editingRole) ? h(RoleModal, {
          ctx,
          role: editingRole ? clone(editingRole) : { id: '', name: '', deptIds: [], categoryBindings: [], desc: '' },
          categories, depts,
          onClose: () => { setCreatingRole(false); setEditingRole(null); },
          onSave: async (role) => {
            const next = editingRole
              ? roles.map((r) => r.id === editingRole.id ? { ...role, id: editingRole.id } : r)
              : [...roles, { ...role, id: `role_${Math.random().toString(36).slice(2, 10)}` }];
            const ok = await saveRoles(next);
            if (ok) { setCreatingRole(false); setEditingRole(null); }
          },
        }) : null);
    }

    /* ============================== 部门页 ============================== */
    function DeptPage({ ctx, notify }) {
      const [depts, setDepts] = useState([]);
      const [roles, setRoles] = useState([]);
      const [users, setUsers] = useState([]);
      const [busy, setBusy] = useState(false);
      const [creatingDept, setCreatingDept] = useState(false);
      const [editingDept, setEditingDept] = useState(null);
      const [expanded, setExpanded] = useState(() => new Set());

      async function reload() {
        setBusy(true);
        try {
          const deptR = await rpcCall(ctx, 'depts.list', {});
          setDepts(deptR.depts || []);
          setRoles(deptR.roles || []);
          setUsers(deptR.users || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function saveDepts(next) {
        try {
          const r = await rpcCall(ctx, 'depts.save', { depts: next });
          setDepts(r.depts || next);
          if (r.roles) setRoles(r.roles);
          if (r.users) setUsers(r.users);
          notify('部门已保存', 'success');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }

      // 构建 parentId -> children 树；悬空的 parentId 视为顶级（host 已修复，这里兜底）
      const childrenOf = useMemo(() => {
        const map = new Map();
        for (const d of depts) {
          const pid = d.parentId && depts.some((x) => x.id === d.parentId) ? d.parentId : '';
          if (!map.has(pid)) map.set(pid, []);
          map.get(pid).push(d);
        }
        return map;
      }, [depts]);
      const roots = childrenOf.get('') || [];
      const usersOf = (deptId) => users.filter((u) => (u.deptIds || []).includes(deptId));
      const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? r.name : id; };
      const toggle = (id) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });

      function renderNode(dept, depth) {
        const kids = childrenOf.get(dept.id) || [];
        const members = usersOf(dept.id);
        const open = expanded.has(dept.id);
        const hasMore = kids.length > 0 || members.length > 0;
        return h('div', { key: dept.id, className: 'mrrp-deptNode' },
          h('div', { className: 'mrrp-deptRow', style: { paddingLeft: depth * 18 }, onClick: () => { if (hasMore) toggle(dept.id); }, title: hasMore ? '点击展开 / 收起（子部门与部门内用户）' : '' },
            h('span', { className: 'mrrp-deptCaret' + (hasMore ? '' : ' is-empty') }, hasMore ? (open ? '▼' : '▶') : '·'),
            h('span', { className: 'mrrp-deptName' }, dept.name),
            h('div', { className: 'mrrp-deptStats' },
              kids.length ? h(Pill, {}, `子部门 ${kids.length}`) : null,
              members.length ? h(Pill, { tone: 'brand' }, `用户 ${members.length}`) : null,
              dept.roleIds && dept.roleIds.length ? h(Pill, {}, `角色 ${dept.roleIds.length}`) : h(Pill, { tone: 'muted' }, '未绑角色')),
            h('div', { className: 'mrrp-deptRow-actions', onClick: (e) => e.stopPropagation() },
              Btn({ size: 'small', onClick: () => setEditingDept(clone(dept)), title: '编辑' }, '编辑'),
              Btn({ size: 'small', variant: 'danger', onClick: async () => { const next = depts.filter((d) => d.id !== dept.id); if (await saveDepts(next)) notify('部门已删除', 'success'); }, title: '删除' }, '删除'))),
          open ? h('div', { className: 'mrrp-deptChildren' },
            members.length ? h('div', { className: 'mrrp-deptUsers', style: { paddingLeft: depth * 18 + 24 } },
              members.map((u) => h('div', { key: u.id, className: 'mrrp-deptUserRow' },
                h('span', { className: 'mrrp-deptUserName' }, u.name),
                u.roleId ? h('span', { className: 'mrrp-deptUserRole' }, roleName(u.roleId)) : h('span', { className: 'mrrp-deptUserRole is-fallback' }, '部门角色'),
                h('span', { className: 'mrrp-deptUserId' }, u.id))))
            : null,
            kids.map((k) => renderNode(k, depth + 1)))
          : null);
      }

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '部门',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${depts.length} 个部门 · 点击部门展开子部门与部门内用户`),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreatingDept(true) }, h(IconPlus, { size: 14 }), '新建部门')),
        },
        depts.length === 0
          ? h(Empty, { title: '还没有部门', desc: '部门用于限定角色 / 用户的生效范围，可绑定多个角色；新建 / 编辑时可选上级部门，收纳为子部门。', icon: h(IconNavDept, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreatingDept(true) }, '新建部门'))
          : h('div', { className: 'mrrp-deptTree' },
            roots.map((d) => renderNode(d, 0))),
        (creatingDept || editingDept) ? h(DeptModal, {
          dept: editingDept ? clone(editingDept) : { id: '', name: '', parentId: '', roleIds: [] },
          depts, roles,
          onClose: () => { setCreatingDept(false); setEditingDept(null); },
          onSave: async (dept) => {
            const next = editingDept
              ? depts.map((d) => d.id === editingDept.id ? { ...dept, id: editingDept.id } : d)
              : [...depts, { ...dept, id: `dept_${Math.random().toString(36).slice(2, 10)}` }];
            const ok = await saveDepts(next);
            if (ok) { setCreatingDept(false); setEditingDept(null); }
          },
        }) : null));
    }

    function RoleModal({ ctx, role, categories, depts, onClose, onSave }) {
      const [name, setName] = useState(role.name);
      const [deptIds, setDeptIds] = useState(role.deptIds || []);
      const [bindings, setBindings] = useState((role.categoryBindings || []).map((b) => ({ categoryId: b.categoryId, modelIds: [...(b.modelIds || [])] })));
      const [desc, setDesc] = useState(role.desc || '');
      const [saving, setSaving] = useState(false);
      const [models, setModels] = useState([]);
      useEffect(() => { (async () => {
        try { const r = await rpcCall(ctx, 'models.list', {}); setModels(r.models || []); } catch (e) { setModels([]); }
      })(); }, []);
      // 某分类下可勾选的模型 = 该分类在「模型分类配置」页已绑定的模型（不显示全部模型）
      const catModelItems = (catId) => {
        const cat = categories.find((c) => c.id === catId);
        const boundKeys = new Set(cat ? (cat.modelIds || []) : []);
        return models.filter((m) => boundKeys.has(modelKey(m))).map((m) => ({ key: modelKey(m), label: m.name, sub: m.provider }));
      };
      const setCatSel = (newSel) => {
        setBindings(categories.filter((c) => newSel.includes(c.id)).map((c) => {
          const old = bindings.find((b) => b.categoryId === c.id);
          return old ? { categoryId: c.id, modelIds: old.modelIds } : { categoryId: c.id, modelIds: [] };
        }));
      };
      const setCatModels = (cid, modelIds) => {
        setBindings(bindings.map((b) => b.categoryId === cid ? { ...b, modelIds } : b));
      };
      const catItems = categories.map((c) => {
        const b = bindings.find((x) => x.categoryId === c.id);
        return { key: c.id, label: c.name, sub: `${(c.modelIds || []).length} 个模型` + (b ? ` · 已配 ${b.modelIds.length} 个可用` : '') };
      });
      return h(Modal, {
        title: role.id ? '编辑角色' : '新建角色', onClose, width: 560,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onSave({ id: role.id, name: name.trim(), deptIds, categoryBindings: bindings, desc: desc.trim() }); setSaving(false); } }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '角色名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '绑定部门', hint: '角色在哪些部门生效；与「部门」页绑定角色双向同步，不选表示全局生效' },
          depts.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建部门，可在「部门」栏添加')
            : h(PickPanel, { items: depts.map((d) => ({ key: d.id, label: d.name })), selected: deptIds, onChange: setDeptIds, searchOf: (it) => it.label, placeholder: '搜索部门名称', emptyText: '暂未创建部门' })),
        h(Field, { label: '绑定模型分类', hint: '支持多选分类；每个分类可单独配置可用的模型（来源于模型列表，可搜索分页）' },
          h(PickPanel, { items: catItems, selected: bindings.map((b) => b.categoryId), onChange: setCatSel, searchOf: (it) => `${it.label} ${it.sub}`, placeholder: '搜索分类名称', emptyText: '暂未创建分类，可到「模型分类配置」页添加' })),
        bindings.length > 0
          ? h('div', { className: 'mrrp-roleCatList' },
              bindings.map((b) => {
                const cat = categories.find((c) => c.id === b.categoryId);
                return h('div', { key: b.categoryId, className: 'mrrp-roleCatItem' },
                  h('div', { className: 'mrrp-roleCatHead' },
                    h('span', { className: 'mrrp-roleCatName' }, cat ? cat.name : b.categoryId),
                    h('span', { className: 'mrrp-roleCatCount' }, `已配 ${b.modelIds.length} 个模型`)),
                  h(PickPanel, { items: catModelItems(b.categoryId), selected: b.modelIds, onChange: (v) => setCatModels(b.categoryId, v), searchOf: (it) => `${it.label} ${it.sub}`, placeholder: '搜索可用模型', emptyText: catModelItems(b.categoryId).length === 0 ? '该分类暂未绑定模型，可到「模型分类配置」页绑定' : '没有匹配的模型' }));
              }))
          : null,
        h(Field, { label: '说明' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: desc, onChange: (e) => setDesc(e.target.value) }))));
    }

    function DeptModal({ dept, depts, roles, onClose, onSave }) {
      const [name, setName] = useState(dept.name);
      const [parentId, setParentId] = useState(dept.parentId);
      const [roleIds, setRoleIds] = useState(dept.roleIds || []);
      const [saving, setSaving] = useState(false);
      // 编辑时禁止选择自己或自己的子孙为上级（避免形成循环）
      const forbidden = useMemo(() => {
        const set = new Set([dept.id]);
        if (dept.id) {
          const stack = [dept.id];
          while (stack.length) {
            const pid = stack.pop();
            for (const d of depts) {
              if (d.parentId === pid && !set.has(d.id)) { set.add(d.id); stack.push(d.id); }
            }
          }
        }
        return set;
      }, [dept.id, depts]);
      const parentOptions = depts.filter((d) => !forbidden.has(d.id)).map((d) => ({ value: d.id, label: d.name }));
      return h(Modal, {
        title: dept.id ? '编辑部门' : '新建部门', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: async () => { setSaving(true); await onSave({ id: dept.id, name: name.trim(), parentId, roleIds }); setSaving(false); } }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: '部门名称' }, h('input', { className: 'mrrp-input', value: name, autoFocus: true, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '上级部门', hint: '选上级部门后收纳为其子部门；不选表示顶级部门' },
          h(Select, { value: parentId, onChange: setParentId, placeholder: '顶级部门',
            options: [{ value: '', label: '（顶级部门）' }, ...parentOptions] })),
        h(Field, { label: '绑定角色', hint: '该部门内哪些角色生效；与「角色」页绑定部门双向同步' },
          roles.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建角色，可在「角色」栏添加')
            : h(PickPanel, { items: roles.map((r) => ({ key: r.id, label: r.name })), selected: roleIds, onChange: setRoleIds, searchOf: (it) => it.label, placeholder: '搜索角色名称', emptyText: '暂未创建角色' }))));
    }

    /* ============================== 用户页 ============================== */
    function UserPage({ ctx, notify }) {
      const [users, setUsers] = useState([]);
      const [roles, setRoles] = useState([]);
      const [depts, setDepts] = useState([]);
      const [busy, setBusy] = useState(false);
      const [search, setSearch] = useState('');
      const [creating, setCreating] = useState(false);
      const [editingUser, setEditingUser] = useState(null);

      async function reload() {
        setBusy(true);
        try {
          const userR = await rpcCall(ctx, 'users.list', {});
          setUsers(userR.users || []);
          setRoles(userR.roles || []);
          setDepts(userR.depts || []);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }
      useEffect(() => { reload(); }, []);

      async function saveUsers(next) {
        try {
          await rpcCall(ctx, 'users.save', { users: next });
          setUsers(next);
          notify('用户已保存', 'success');
          return true;
        } catch (error) { notify(error.message, 'error'); return false; }
      }
      async function syncIm() {
        try {
          const r = await rpcCall(ctx, 'users.syncIm', {});
          setUsers(r.users || []);
          setRoles(r.roles || []);
          setDepts(r.depts || []);
          notify(r.created > 0 ? `已从 dsh-im 同步 ${r.created} 个新用户` : '没有新的 dsh-im 用户', 'success');
        } catch (error) { notify(error.message, 'error'); }
      }
      const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? r.name : '—'; };
      const deptName = (id) => { const d = depts.find((x) => x.id === id); return d ? d.name : '—'; };
      function userRoleLabel(u) {
        if (u.roleId) return roleName(u.roleId);
        const ids = [];
        for (const did of u.deptIds || []) {
          const d = depts.find((x) => x.id === did);
          if (d && d.roleIds) ids.push(...d.roleIds);
        }
        const uniq = [...new Set(ids)];
        if (!uniq.length) return h('span', { className: 'mrrp-muted' }, '—');
        const names = uniq.map((id) => { const r = roles.find((x) => x.id === id); return r ? r.name : id; });
        return h('span', { className: 'mrrp-roleFallback', title: '未单独绑定角色，使用所属部门绑定的角色' }, `部门角色：${names.join('、')}`);
      }

      const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return users;
        return users.filter((u) => `${u.name} ${u.id} ${roleName(u.roleId)} ${(u.deptIds || []).map(deptName).join(' ')}`.toLowerCase().includes(q));
      }, [users, search, roles, depts]);

      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '用户',
          extra: h('div', { className: 'mrrp-card-extra-inline' },
            h('span', { className: 'mrrp-card-sub' }, `${users.length} 个用户`),
            h('div', { className: 'mrrp-search' }, h('input', { className: 'mrrp-search-input', placeholder: '搜索姓名 / ID / 部门 / 角色', value: search, onChange: (e) => setSearch(e.target.value) })),
            h(Btn, { size: 'small', onClick: syncIm, title: '扫描 dsh-im 首次出现的发送者并自动建用户' }, '同步 dsh-im'),
            h(Btn, { size: 'small', variant: 'primary', onClick: () => setCreating(true) }, h(IconPlus, { size: 14 }), '新建用户')),
        },
        users.length === 0
          ? h(Empty, { title: '还没有用户', desc: '新建用户可用 dsh-im 的 senderId 作为唯一标识；dsh-im 中首次出现的发送者会自动创建用户。', icon: h(IconNavUsers, { size: 22 }) },
              h(Btn, { variant: 'primary', onClick: () => setCreating(true) }, '新建用户'))
          : h('div', { className: 'mrrp-tableWrap' },
            h('table', { className: 'mrrp-table' },
              h('thead', null, h('tr', null,
                h('th', null, '姓名'),
                h('th', null, 'ID'),
                h('th', null, '部门'),
                h('th', null, '角色'),
                h('th', null, '备注'),
                h('th', { className: 'is-right' }, '操作'))),
              h('tbody', null,
                filtered.map((u) => h('tr', { key: u.id },
                  h('td', null, h('span', { className: 'mrrp-userName' }, u.name)),
                  h('td', null, h('span', { className: 'mrrp-userId', title: 'dsh-im senderId（唯一标识）' }, u.id)),
                  h('td', null, (u.deptIds || []).length
                    ? h('div', { className: 'mrrp-userDeptChips' }, (u.deptIds || []).map((id) => h(Pill, { key: id }, deptName(id))))
                    : h('span', { className: 'mrrp-muted' }, '—')),
                  h('td', null, userRoleLabel(u)),
                  h('td', null, h('span', { className: 'mrrp-muted' }, u.note || '—')),
                  h('td', { className: 'is-right' }, h('div', { className: 'mrrp-rowActions' },
                    Btn({ size: 'small', onClick: () => setEditingUser(clone(u)), title: '编辑' }, '编辑'),
                    Btn({ size: 'small', variant: 'danger', onClick: async () => { const next = users.filter((x) => x.id !== u.id); if (await saveUsers(next)) notify('用户已删除', 'success'); }, title: '删除' }, '删除')))))))),

        (creating || editingUser) ? h(UserModal, {
          user: editingUser ? clone(editingUser) : { id: '', name: '', roleId: '', deptIds: [], note: '' },
          roles, depts,
          onClose: () => { setCreating(false); setEditingUser(null); },
          onSave: async (user) => {
            const next = editingUser
              ? users.map((u) => u.id === editingUser.id ? { ...user, id: editingUser.id } : u)
              : [...users, user];
            const ok = await saveUsers(next);
            if (ok) { setCreating(false); setEditingUser(null); }
          },
        }) : null));
    }

    function UserModal({ user, roles, depts, onClose, onSave }) {
      const isEdit = Boolean(user.id);
      const [id, setId] = useState(user.id || '');
      const [name, setName] = useState(user.name);
      const [roleId, setRoleId] = useState(user.roleId);
      const [deptIds, setDeptIds] = useState(user.deptIds || []);
      const [note, setNote] = useState(user.note || '');
      const [saving, setSaving] = useState(false);

      function save() {
        if (!isEdit && !id.trim()) { notify('请填写 ID（dsh-im 的 senderId，作为用户唯一标识）', 'error'); return; }
        if (!name.trim()) { notify('请填写姓名', 'error'); return; }
        setSaving(true);
        onSave({ id: id.trim(), name: name.trim(), roleId, deptIds, note: note.trim() });
      }

      return h(Modal, {
        title: isEdit ? '编辑用户' : '新建用户', onClose, width: 480,
        footer: h('div', { className: 'mrrp-modal-actions' },
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? h(Spinner, {}) : '保存')),
      },
      h('div', { className: 'mrrp-form' },
        h(Field, { label: isEdit ? 'ID（唯一标识）' : 'ID（dsh-im 的 senderId）', hint: isEdit ? '用户的唯一标识，不可修改' : '用户唯一标识，如钉钉对话里的 senderId；dsh-im 中首次出现的发送者会自动创建用户' },
          isEdit
            ? h('span', { className: 'mrrp-input mrrp-idStatic' }, id)
            : h('input', { className: 'mrrp-input', value: id, placeholder: '如 ou_xxxx / staffId', onChange: (e) => setId(e.target.value) })),
        h(Field, { label: '姓名' }, h('input', { className: 'mrrp-input', value: name, autoFocus: !isEdit, onChange: (e) => setName(e.target.value) })),
        h(Field, { label: '部门（可多选）', hint: '说明用户属于哪些部门；可归属于多个部门' },
          depts.length === 0
            ? h('span', { className: 'mrrp-hint' }, '暂未创建部门，可在「部门」栏添加')
            : h(PickPanel, { items: depts.map((d) => ({ key: d.id, label: d.name })), selected: deptIds, onChange: setDeptIds, searchOf: (it) => it.label, placeholder: '搜索部门名称', emptyText: '暂未创建部门' })),
        h(Field, { label: '角色', hint: '留空则使用所属部门绑定的角色' }, h(Select, { value: roleId, onChange: setRoleId, placeholder: '选择角色（留空 = 用部门角色）', options: roles.map((r) => ({ value: r.id, label: r.name })) })),
        h(Field, { label: '备注' }, h('textarea', { className: 'mrrp-input mrrp-textarea', value: note, onChange: (e) => setNote(e.target.value) }))));
    }

    /* ============================== 设置抽屉 ============================== */
    function SettingsDrawer({ ctx, notify, onClose, onModeChange }) {
      const [sidebarMode, setSidebarMode] = useState('auto');
      const [info, setInfo] = useState(null);
      const [busy, setBusy] = useState(false);

      async function reload() {
        try {
          const [entry, st] = await Promise.all([
            rpcCall(ctx, 'sidebar-entry.get', {}),
            rpcCall(ctx, 'status', {}),
          ]);
          setSidebarMode(entry.mode || 'auto');
          setInfo(st);
        } catch (error) { notify(error.message, 'error'); }
      }
      useEffect(() => { reload(); }, []);

      async function setMode(mode) {
        setBusy(true);
        try {
          await rpcCall(ctx, 'sidebar-entry.set', { mode });
          setSidebarMode(mode);
          notify('侧边栏入口已更新', 'success');
          onModeChange && onModeChange(mode);
        } catch (error) { notify(error.message, 'error'); }
        finally { setBusy(false); }
      }

      const modeOptions = [
        { value: 'auto', label: '自动（未配置路由时显示入口，配置后自动隐藏）' },
        { value: 'show', label: '始终显示' },
        { value: 'hide', label: '始终隐藏' },
      ];

      return h('div', { className: 'mrrp-drawerOverlay', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'mrrp-floatCard' },
          h('div', { className: 'mrrp-floatCard-head' },
            h('div', { className: 'mrrp-brandRow' },
              h('span', { className: 'mrrp-brandDot' }),
              h('span', { className: 'mrrp-brandText' }, '设置'),
              h('span', { className: 'mrrp-version' }, `v${PLUGIN_VERSION}`)),
            IconBtn({ onClick: onClose, title: '关闭' }, h(IconX, { size: 16 }))),
          h('div', { className: 'mrrp-floatCard-body' },
            h(Card, { title: '侧边栏入口' },
              h('div', { className: 'mrrp-form' },
                h(Field, { label: '在 DSH 侧边栏显示「MRRP」入口', hint: '控制 DSH 左侧栏是否出现 MRRP 快捷入口' },
                  h(Select, { value: sidebarMode, onChange: setMode, disabled: busy, options: modeOptions })))),
            h(Card, { title: '插件信息' },
              info ? h('div', { className: 'mrrp-kv' },
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '版本'), h('span', {}, PLUGIN_VERSION)),
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '模型提供方'), h('span', {}, info.providers)),
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '已发现模型'), h('span', {}, info.models)),
                h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '分类 / 角色 / 用户'), h('span', {}, `${info.categories} / ${info.roles} / ${info.users}`)),
                info.configPath ? h('div', { className: 'mrrp-kvRow' }, h('span', { className: 'mrrp-kvKey' }, '配置存储'), h('span', { className: 'mrrp-kvPath', title: info.configPath }, info.configPath)) : null,
                info.llmError ? h('div', { className: 'mrrp-notice mrrp-notice-warn' }, `模型发现异常：${info.llmError}`) : h('div', { className: 'mrrp-notice' }, '模型发现接口正常。'))
              : h(Spinner, { size: 20 })),
            h('p', { className: 'mrrp-hint' }, 'MRRP 控制台只通过 /api/mrrp 管理通道读写配置，不拦截 DSH 主链路。'))));
    }

    /* ============================== 路由决策日志页 ============================== */
    function LogsPage({ ctx, notify }) {
      const [logs, setLogs] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [expanded, setExpanded] = useState(null);
      const [panelVisible, setPanelVisible] = useState(false);
      const [panelOpen, setPanelOpen] = useState(false);
      const [limit, setLimit] = useState(100);
      // 详情面板：从左侧滑出（覆盖表格左 2/3）；收起先播滑出动画再卸载
      const areaRef = useRef(null);
      const [areaH, setAreaH] = useState(null);
      const measureArea = useCallback(() => {
        if (typeof window === 'undefined' || !window.innerHeight) return;
        const el = areaRef.current;
        if (!el || typeof el.getBoundingClientRect !== 'function') return;
        const rect = el.getBoundingClientRect();
        const h = Math.max(200, Math.floor(window.innerHeight - rect.top - 24));
        setAreaH((prev) => (prev === h ? prev : h));
      }, []);
      useEffect(() => {
        measureArea();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measureArea);
          return () => window.removeEventListener('resize', measureArea);
        }
        return undefined;
      }, [measureArea]);
      const openPanel = (i) => {
        setExpanded(i);
        setPanelVisible(true);
        setPanelOpen(false);
        requestAnimationFrame(() => requestAnimationFrame(() => setPanelOpen(true)));
      };
      const closePanel = () => {
        setPanelOpen(false);
        setTimeout(() => { setPanelVisible(false); setExpanded(null); }, 180);
      };
      const load = useCallback(() => {
        setBusy(true); setError('');
        rpcCall(ctx, 'logs.read', { limit })
          .then((r) => { setLogs(r.logs || []); if (!r.logs || !r.logs.length) setError('暂无日志：还没有产生路由决策记录'); })
          .catch((e) => setError((e && e.message) || '读取日志失败'))
          .finally(() => setBusy(false));
      }, [ctx, limit]);
      useEffect(() => { load(); }, [load]);

      const fmtTime = (ts) => {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return ts || '';
        return d.toLocaleString('zh-CN', { hour12: false });
      };
      const eventMeta = (row) => {
        const ev = row.event || '';
        const map = {
          'decide-before': { tone: 'info', label: '决策请求' },
          'decide-after': { tone: 'ok', label: '决策返回' },
          'decide-error': { tone: 'err', label: '决策失败' },
          route: { tone: row.branch === 'laya' ? 'ok' : (row.branch === 'fallback' ? 'warn' : 'info'), label: '路由结果' },
          'cache-hit': { tone: 'info', label: '缓存命中' },
          'unknown-sender': { tone: 'warn', label: '未知发送者' },
          'decision-disabled': { tone: 'warn', label: '路由未启动' },
          'no-route': { tone: 'err', label: '未路由' },
        };
        return map[ev] || { tone: 'info', label: ev || '观测' };
      };
      const pickedFromRaw = (raw) => {
        try {
          if (!raw || typeof raw !== 'object') return '';
          const answers = raw.answers;
          if (answers && typeof answers === 'object') {
            for (const key of Object.keys(answers)) {
              const a = answers[key];
              if (a && typeof a === 'object' && typeof a.choice === 'string' && a.choice) return a.choice;
            }
          }
          if (typeof raw.choice === 'string' && raw.choice) return raw.choice;
          if (typeof raw.model === 'string' && raw.model) return raw.model;
        } catch { /* ignore */ }
        return '';
      };
      const modelOf = (row) => {
        if (row.event === 'route' || row.event === 'cache-hit') return row.model || '';
        if (row.event === 'decide-after') return pickedFromRaw(row.raw) || '';
        return '';
      };
      const detailOf = (row) => {
        if (row.event === 'route') {
          const parts = [];
          if (row.model) parts.push(`模型：${row.model}`);
          parts.push(`来源：${row.branch || ''}`);
          if (row.candidates && row.candidates.length) parts.push(`候选 ${row.candidates.length} 个`);
          return parts.join(' · ');
        }
        if (row.event === 'cache-hit') return `会话决策缓存（${row.source || ''}）`;
        if (row.event === 'decide-before') {
          const criteria = (row.questions && row.questions.model && row.questions.model.criteria) || {};
          return `决策请求已发出 · 候选 ${Object.keys(criteria).length} 个 · 超时 ${row.timeoutMs || 0}ms`;
        }
        if (row.event === 'decide-after') return `Laya 返回 · 选中 ${pickedFromRaw(row.raw) || '(未命中候选)'}`;
        if (row.event === 'decide-error') return `错误：${row.message || ''}`;
        if (row.event === 'unknown-sender') return (row.message || '') + (row.session ? ` · 会话 ${row.session}` : '');
        return '';
      };

      const current = expanded !== null && logs ? logs[expanded] : null;
      return h('div', { className: 'mrrp-section' },
        h(Card, {
          title: '路由决策日志',
          sub: 'route-decision.log · 每次对话的 Laya 决策与模型选择（最新在前）',
          extra: h('div', { className: 'mrrp-card-extra' },
            h(Select, { value: String(limit), onChange: (v) => setLimit(Number(v)), options: [
              { value: '50', label: '50 条' }, { value: '100', label: '100 条' }, { value: '200', label: '200 条' },
            ] }),
            Btn({ size: 'small', onClick: load, disabled: busy, title: '刷新' }, busy ? '读取中…' : '刷新')),
        },
          error ? h('div', { className: 'mrrp-notice' + (error.includes('暂无') ? '' : ' mrrp-notice-warn') }, error)
            : logs === null ? h(Spinner, { size: 20 })
              : logs.length === 0 ? h('div', { className: 'mrrp-notice' }, '暂无路由决策日志。')
                : h('div', { ref: areaRef, className: 'mrrp-logArea', style: areaH ? { maxHeight: areaH + 'px' } : null },
                  h('div', { className: 'mrrp-tableWrap' },
                    h('table', { className: 'mrrp-table mrrp-logTable' },
                      h('thead', {}, h('tr', {},
                        h('th', {}, '时间'),
                        h('th', {}, '事件'),
                        h('th', {}, '发送者'),
                        h('th', {}, '决策 / 模型'),
                        h('th', { className: 'is-right' }, ''))),
                      h('tbody', {}, logs.map((row, i) => {
                        const meta = eventMeta(row);
                        const model = modelOf(row);
                        const detail = detailOf(row);
                        const open = expanded === i;
                        return h('tr', { key: i, className: 'mrrp-logRow' + (open ? ' is-open' : ''), onClick: () => (open ? closePanel() : openPanel(i)) },
                          h('td', {}, h('span', { className: 'mrrp-logTime', title: row.ts }, fmtTime(row.ts))),
                          h('td', {}, h('span', { className: 'mrrp-tag mrrp-tag-' + meta.tone }, meta.label)),
                          h('td', {}, row.senderName ? `${row.senderName}${row.senderId ? `（${row.senderId}）` : ''}` : (row.senderId || '—')),
                          h('td', {},
                            model ? h('span', { className: 'mrrp-logModel', title: model }, model) : null,
                            detail ? h('span', { className: 'mrrp-logText' }, detail) : null),
                          h('td', { className: 'is-right' }, h('span', { className: 'mrrp-logExpand' }, open ? '收起' : '详情')));
                      })))),
                  panelVisible && current ? h('div', { className: 'mrrp-logPanel' + (panelOpen ? ' is-open' : '') },
                    h('div', { className: 'mrrp-logPanel-head' },
                      h('span', { className: 'mrrp-logPanel-title' }, '原始记录'),
                      IconBtn({ onClick: closePanel, title: '收起' }, h(IconX, { size: 14 }))),
                    h('div', { className: 'mrrp-logPanel-body' },
                      h('pre', { className: 'mrrp-logRaw' }, JSON.stringify(current, null, 2)))) : null)));
    }

    /* ============================== 导航（两级子菜单） ============================== */
    const NAV = [
      {
        key: 'models', label: '模型管理', icon: IconNavCategories, children: [
          { key: 'route', label: '路由配置', icon: IconNavRoute },
          { key: 'decision', label: '决策模型配置', icon: IconNavDecision },
          { key: 'category', label: '模型分类配置', icon: IconNavCategories },
          { key: 'modellist', label: '模型列表', icon: IconNavModels },
        ],
      },
      {
        key: 'org', label: '角色部门', icon: IconNavRoles, children: [
          { key: 'role', label: '角色', icon: IconNavRoles },
          { key: 'dept', label: '部门', icon: IconNavDept },
          { key: 'user', label: '用户', icon: IconNavUsers },
        ],
      },
      {
        key: 'diag', label: '日志管理', icon: IconNavLog, children: [
          { key: 'logs', label: '日志', icon: IconNavLog },
        ],
      },
    ];

    function MrrpPage({ ctx, applySidebarMode }) {
      const [route, setRoute] = useState('route');
      const [collapsed, setCollapsed] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [toasts, setToasts] = useState([]);
      const [openGroup, setOpenGroup] = useState({ models: true, org: true, diag: true });
      const [versionInfo, setVersionInfo] = useState({
        current: PLUGIN_VERSION, latest: null, updateAvailable: false, checking: false, command: null,
      });

      const notify = useCallback((message, tone = 'info') => {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
      }, []);
      const dismiss = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

      // 启动时自动检查一次插件版本（GitHub Release；网络不可达时静默）。
      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const value = await rpcCall(ctx, 'version.check');
            if (!alive) return;
            setVersionInfo({
              current: value?.current ?? PLUGIN_VERSION,
              latest: value?.latest ?? null,
              updateAvailable: Boolean(value?.updateAvailable),
              command: value?.command ?? null,
              checking: false,
            });
            if (value?.updateAvailable && value?.latest) {
              notify(`发现新版本 v${value.latest}，点击顶部版本号可复制更新命令`, 'info');
            }
          } catch {
            if (alive) setVersionInfo((v) => ({ ...v, checking: false }));
          }
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const checkVersion = useCallback(async () => {
        setVersionInfo((v) => ({ ...v, checking: true }));
        try {
          const value = await rpcCall(ctx, 'version.check');
          setVersionInfo({
            current: value?.current ?? PLUGIN_VERSION,
            latest: value?.latest ?? null,
            updateAvailable: Boolean(value?.updateAvailable),
            command: value?.command ?? null,
            checking: false,
          });
          if (value?.updateAvailable && value?.latest) {
            notify(`发现新版本 v${value.latest}，点击顶部版本号可复制更新命令`, 'info');
          } else {
            notify('已是最新版本', 'success');
          }
        } catch (cause) {
          setVersionInfo((v) => ({ ...v, checking: false }));
          notify(cause?.message ?? '版本检查失败', 'error');
        }
      }, [notify]);

      const copyUpdateCommand = useCallback(() => {
        if (!versionInfo.command) return;
        void (navigator.clipboard?.writeText(versionInfo.command).then(() => {
          notify(`更新命令已复制：${versionInfo.command}`, 'success');
        }).catch(() => {
          notify(`请手动执行更新命令：${versionInfo.command}`, 'info');
        }));
      }, [versionInfo.command, notify]);

      const pageProps = { ctx, notify };
      let page;
      if (route === 'route') page = h(RouteConfigPage, pageProps);
      else if (route === 'decision') page = h(DecisionConfigPage, pageProps);
      else if (route === 'category') page = h(CategoryConfigPage, pageProps);
      else if (route === 'modellist') page = h(ModelListPage, pageProps);
      else if (route === 'role') page = h(RolePage, pageProps);
      else if (route === 'dept') page = h(DeptPage, pageProps);
      else if (route === 'logs') page = h(LogsPage, pageProps);
      else page = h(UserPage, pageProps);

      const leafLabel = (() => {
        for (const group of NAV) {
          const child = group.children.find((c) => c.key === route);
          if (child) return child.label;
        }
        return '';
      })();

      const toggleGroup = (key) => setOpenGroup((s) => ({ ...s, [key]: !s[key] }));

      return h('div', { className: 'mrrp-page' },
        h('div', { className: 'mrrp-topbar' },
          h('div', { className: 'mrrp-brandRow' },
            h('span', { className: 'mrrp-brandDot' }),
            h('span', { className: 'mrrp-brandText' }, 'MRRP'),
            h('span', { className: 'mrrp-brandSub' }, '模型路由控制台'),
            h('span', {
              className: 'mrrp-version' + (versionInfo.updateAvailable ? ' mrrp-versionNew' : ''),
              title: versionInfo.checking ? '正在检查更新…'
                : versionInfo.updateAvailable ? `发现新版本 v${versionInfo.latest}，点击复制更新命令`
                : '已是最新版本，点击检查更新',
              onClick: versionInfo.updateAvailable ? copyUpdateCommand : checkVersion,
            }, versionInfo.updateAvailable
              ? `v${versionInfo.current} ↑ v${versionInfo.latest}`
              : versionInfo.checking ? `v${versionInfo.current}…` : `v${versionInfo.current}`)),
          h('div', { className: 'mrrp-topbarRight' },
            Btn({ size: 'small', onClick: () => setSettingsOpen(true), title: '设置' }, '设置'))),
        versionInfo.updateAvailable ? h('div', { className: 'mrrp-updateBanner' },
          h('span', { className: 'mrrp-updateBannerText' },
            '发现新版本 ', h('strong', null, `v${versionInfo.latest}`), `（当前 v${versionInfo.current}）。`),
          h('button', { type: 'button', className: 'mrrp-btn mrrp-btn-small', onClick: copyUpdateCommand }, '复制更新命令')) : null,
        h('div', { className: 'mrrp-body' },
          h('aside', { className: `mrrp-sidebar${collapsed ? ' is-collapsed' : ''}` },
            h('nav', { className: 'mrrp-nav' },
              NAV.map((group) => {
                const isOpen = !!openGroup[group.key];
                const GroupIcon = group.icon;
                return h('div', { key: group.key, className: 'mrrp-navGroup' },
                  h('button', {
                    className: `mrrp-navItem mrrp-navGroupHead${isOpen ? ' is-open' : ''}`,
                    title: group.label, onClick: () => toggleGroup(group.key),
                  },
                  h('span', { className: 'mrrp-navIcon' }, h(GroupIcon, { size: 17 })),
                  collapsed ? null : h('span', { className: 'mrrp-navLabel' }, group.label),
                  collapsed ? null : h('span', { className: 'mrrp-navCaret' }, isOpen ? h(IconChevronDown, { size: 14 }) : h(IconChevronRight, { size: 14 }))),
                  (!collapsed && isOpen) ? h('div', { className: 'mrrp-navSub' },
                    group.children.map((child) => {
                      const ChildIcon = child.icon;
                      const active = route === child.key;
                      return h('button', {
                        key: child.key,
                        className: `mrrp-navItem mrrp-navSubItem${active ? ' is-active' : ''}`,
                        title: child.label, onClick: () => setRoute(child.key),
                      },
                      h('span', { className: 'mrrp-navIcon' }, h(ChildIcon, { size: 15 })),
                      h('span', { className: 'mrrp-navLabel' }, child.label));
                    })) : null);
              })),
            h('button', {
              className: `mrrp-collapseHandle${collapsed ? ' is-collapsed' : ''}`,
              title: collapsed ? '展开侧边栏' : '收起侧边栏',
              onClick: () => setCollapsed((v) => !v),
            }, collapsed ? h(IconExpand, { size: 18 }) : h(IconCollapse, { size: 18 }))),
          h('main', { className: 'mrrp-content' },
            h('div', { className: 'mrrp-contentHead' },
              h('h2', {}, leafLabel),
              h('span', { className: 'mrrp-contentSub' }, '通过 /api/mrrp 管理通道读写配置')),
            h('div', { className: 'mrrp-contentBody' }, page))),
        h(ToastStack, { toasts, onDismiss: dismiss }),
        settingsOpen ? h(SettingsDrawer, { ctx, notify, onClose: () => setSettingsOpen(false), onModeChange: applySidebarMode }) : null);
    }

    /* ============================== 样式（DSH 浅色主题变量） ============================== */
    const styles = `
.mrrp-page { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-module-platform, #f7f8fa); box-sizing: border-box; font-family: inherit; }
.mrrp-page *, .mrrp-page *::before, .mrrp-page *::after { box-sizing: border-box; }
.mrrp-topbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px clamp(16px, 3vw, 32px); border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-brandRow { display: flex; align-items: center; gap: 10px; }
.mrrp-brandDot { width: 10px; height: 10px; border-radius: 50%; background: #38c7bc; box-shadow: 0 0 0 4px rgba(56, 199, 188, .15); }
.mrrp-brandText { font-size: 16px; font-weight: 750; letter-spacing: .02em; }
.mrrp-brandSub { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.mrrp-topbarRight { display: flex; align-items: center; gap: 10px; }
.mrrp-version { color: var(--dsw-alias-label-tertiary, #8f959e); font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; transition: color .12s ease; }
.mrrp-version:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-versionNew { color: #b45309; font-weight: 700; }
.mrrp-versionNew:hover { color: #d97706; }
.mrrp-updateBanner { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px clamp(16px, 3vw, 32px) 0; padding: 9px 14px; border: 1px solid #f3d19e; border-radius: 10px; background: #fff8ec; color: #7a4d00; font-size: 12.5px; }
.mrrp-updateBannerText { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; }
.mrrp-updateBanner strong { color: #b45309; }
.mrrp-body { flex: 1 1 auto; min-height: 0; display: flex; }
.mrrp-sidebar { flex: 0 0 176px; width: 176px; position: relative; display: flex; flex-direction: column; gap: 4px; padding: 12px 12px; border-right: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); transition: width .16s ease, flex-basis .16s ease; }
.mrrp-sidebar.is-collapsed { flex: 0 0 52px; width: 52px; }
.mrrp-nav { display: flex; flex-direction: column; gap: 4px; }
.mrrp-navGroup { display: flex; flex-direction: column; gap: 2px; }
.mrrp-navItem { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; padding: 0 10px; border: 0; border-radius: 9px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: 500 13px/1 inherit; text-align: left; cursor: pointer; transition: background .12s ease, color .12s ease; }
.mrrp-navItem:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-navItem.is-active { color: #0e8f84; background: rgba(56, 199, 188, .12); font-weight: 650; }
.mrrp-navIcon { display: inline-flex; align-items: center; }
.mrrp-navLabel { white-space: nowrap; overflow: hidden; }
.mrrp-navCaret { margin-left: auto; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-navGroupHead.is-open { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 650; }
.mrrp-navSub { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 4px 6px; padding-left: 8px; border-left: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-navSubItem { min-height: 34px; padding-left: 6px; font-size: 12.5px; font-weight: 400; }
.mrrp-sidebar.is-collapsed .mrrp-navItem { justify-content: center; padding: 0; }
.mrrp-collapseHandle { position: absolute; right: -9px; top: 50%; transform: translateY(-50%); z-index: 6; display: flex; align-items: center; justify-content: center; width: 17px; height: 48px; padding: 0; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 8px; color: var(--dsw-alias-label-tertiary, #8f959e); background: var(--dsw-alias-bg-layer-2, #fff); cursor: pointer; box-shadow: 0 1px 3px rgb(31 35 41 / 8%); transition: color .12s ease, border-color .12s ease, background .12s ease; }
.mrrp-collapseHandle:hover { color: #0e8f84; border-color: #38c7bc; background: rgba(56, 199, 188, .06); }
.mrrp-singleCard { max-width: 720px; }
.mrrp-imRouteDesc { padding: 10px 12px; margin: 4px 0 12px; border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: rgba(56, 199, 188, .08); border: 1px solid rgba(56, 199, 188, .22); font-size: 12.5px; line-height: 1.65; }
.mrrp-textarea { min-height: 74px; resize: vertical; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.mrrp-ruleHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 14px 0 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; }
.mrrp-ruleRow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mrrp-ruleField { flex: 0 0 32%; min-width: 0; }
.mrrp-ruleValue { flex: 0 0 30%; min-width: 0; }
.mrrp-ruleCat { flex: 1 1 auto; min-width: 0; }
.mrrp-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.mrrp-contentHead { flex: 0 0 auto; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 22px clamp(16px, 3vw, 32px) 0; }
.mrrp-contentHead h2 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 750; }
.mrrp-contentSub { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.mrrp-contentBody { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px clamp(16px, 3vw, 32px) 32px; }
.mrrp-section { display: flex; flex-direction: column; gap: 16px; }
.mrrp-topSplit { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.mrrp-card { border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.mrrp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-card-head h3 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 700; }
.mrrp-card-sub { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.mrrp-card-extra { display: flex; align-items: center; gap: 10px; }
.mrrp-card-extra-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mrrp-card-body { padding: 16px; }
.mrrp-card-foot { display: flex; justify-content: flex-end; padding-top: 4px; }
.mrrp-formGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.mrrp-form { display: flex; flex-direction: column; gap: 16px; }
.mrrp-formToggles { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.mrrp-field { display: grid; gap: 6px; }
.mrrp-field-label { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; font-weight: 560; }
.mrrp-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-input, .mrrp-select { width: 100%; box-sizing: border-box; min-height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/34px inherit; outline: none; }
.mrrp-select { cursor: pointer; }
.mrrp-textarea { min-height: 84px; padding: 8px 10px; line-height: 1.55; resize: vertical; font-family: inherit; }
.mrrp-input:focus-visible, .mrrp-select:focus-visible, .mrrp-textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 1px; }
.mrrp-toggle { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); cursor: pointer; }
.mrrp-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.mrrp-toggle-track { position: relative; width: 34px; height: 20px; flex: none; border-radius: 999px; background: var(--dsw-alias-bg-fill-2, #dfe1e5); transition: background .15s ease; }
.mrrp-toggle input:checked + .mrrp-toggle-track { background: #38c7bc; }
.mrrp-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(31 35 41 / 25%); transition: transform .15s ease; }
.mrrp-toggle input:checked + .mrrp-toggle-track .mrrp-toggle-thumb { transform: translateX(14px); }
.mrrp-toggle-text { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.mrrp-toggle-text small { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-btn { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 500 13px/1 inherit; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.mrrp-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.mrrp-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.mrrp-btn:disabled { opacity: .55; cursor: not-allowed; }
.mrrp-btn-primary { border-color: #38c7bc; color: #fff; background: #38c7bc; }
.mrrp-btn-primary:hover:not(:disabled) { background: #2fb3a8; }
.mrrp-btn-danger { border-color: var(--dsw-alias-state-error-primary, #d54941); color: var(--dsw-alias-state-error-primary, #d54941); }
.mrrp-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, transparent); }
.mrrp-btn-small { min-height: 28px; padding: 0 9px; font-size: 12px; border-radius: 7px; }
.mrrp-btn-icon { width: 32px; height: 32px; padding: 0; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-btn-icon:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-btn-icon { display: inline-flex; align-items: center; justify-content: center; }
.mrrp-btn-icon .mrrp-ico { display: inline-flex; }
.mrrp-ico { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; flex-shrink: 0; line-height: 1; font-weight: 600; font-style: normal; }
/* 默认禁用所有伪元素；仅对“纯 background / box-shadow”形状按类重新启用（现场验证此类可渲染） */
.mrrp-ico::before, .mrrp-ico::after { content: none; }
/* 加号 + */
.ico-plus::before, .ico-plus::after { content: ''; position: absolute; display: block; box-sizing: border-box; }
.ico-plus::before { left: 0.14em; top: 0.45em; width: 0.72em; height: 0.1em; border-radius: 0.05em; background: currentColor; }
.ico-plus::after { left: 0.45em; top: 0.14em; width: 0.1em; height: 0.72em; border-radius: 0.05em; background: currentColor; }
/* 导航：三层（模型分类配置） */
.ico-navLayers::before { content: ''; position: absolute; display: block; left: 0.06em; top: 0.08em; width: 0.76em; height: 0.18em; border-radius: 0.05em; background: currentColor; box-shadow: 0 0.26em 0 currentColor, 0 0.52em 0 currentColor; }
/* 导航：列表（模型列表） */
.ico-navList::before { content: ''; position: absolute; display: block; left: 0.18em; top: 0.16em; width: 0.64em; height: 0.1em; border-radius: 0.05em; background: currentColor; box-shadow: 0 0.24em 0 currentColor, 0 0.48em 0 currentColor; }
/* 导航：人（角色 / 用户） */
.ico-navPerson::before { content: ''; position: absolute; display: block; left: 50%; top: 0.1em; width: 0.3em; height: 0.3em; margin-left: -0.15em; border-radius: 50%; background: currentColor; }
.ico-navPerson::after { content: ''; position: absolute; display: block; left: 50%; top: 0.5em; width: 0.62em; height: 0.32em; margin-left: -0.31em; border-radius: 0.32em 0.32em 0.1em 0.1em; background: currentColor; }
/* 圆点 */
.ico-dot::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.42em; height: 0.42em; margin: -0.21em 0 0 -0.21em; border-radius: 50%; background: currentColor; }
/* 侧边栏入口：圆角方块（纯 background，渲染分界内最可靠） */
.ico-sidebarTile::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.5em; height: 0.5em; margin: -0.25em 0 0 -0.25em; border-radius: 0.13em; background: currentColor; }
/* 导航：路由配置（折线三点：路径转折 / 路由分发） */
.ico-navRoute::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.18em; height: 0.18em; margin: -0.09em 0 0 -0.09em; border-radius: 50%; background: currentColor; box-shadow: -0.3em 0.28em 0 currentColor, 0.3em -0.28em 0 currentColor; }
/* 导航：决策模型配置（中心点 + 右上分支点：决策 / 选择） */
.ico-navDecision::before { content: ''; position: absolute; display: block; left: 50%; top: 50%; width: 0.18em; height: 0.18em; margin: -0.09em 0 0 -0.09em; border-radius: 50%; background: currentColor; box-shadow: 0.34em -0.34em 0 currentColor; }
/* 其余图标（× « » √ → ▼ ▶ ⌂ 等）一律使用文本字符渲染，CSS 形状仅对上述“纯背景/阴影”类保留 */
.mrrp-sidebarIcon { color: #38c7bc; display: inline-flex; }
.mrrp-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--dsw-alias-bg-module-platform, #f2f3f5); color: var(--dsw-alias-label-secondary, #646a73); white-space: nowrap; }
.mrrp-pill-brand { color: #0e8f84; background: rgba(56, 199, 188, .14); }
.mrrp-pill-info { color: var(--dsw-alias-state-business-primary, #3370ff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 10%, transparent); }
.mrrp-pill-muted { color: var(--dsw-alias-label-tertiary, #8f959e); background: transparent; }
.mrrp-catList { display: flex; flex-direction: column; gap: 8px; }
.mrrp-catItem { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; cursor: pointer; transition: border-color .12s ease, background .12s ease; }
.mrrp-catItem:hover { border-color: #38c7bc; }
.mrrp-catItem.is-active { border-color: #38c7bc; background: rgba(56, 199, 188, .06); }
.mrrp-catItem-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mrrp-catItem-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mrrp-catItem-name { font-size: 13px; font-weight: 650; }
.mrrp-catItem-desc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-catItem-actions { display: flex; align-items: center; gap: 2px; }
.mrrp-tableWrap { overflow-x: auto; }
.mrrp-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.mrrp-table th, .mrrp-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); font-size: 13px; vertical-align: middle; }
.mrrp-table th { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; font-weight: 600; white-space: nowrap; }
.mrrp-table th:nth-child(1) { width: 30%; }
.mrrp-table th:nth-child(2) { width: 18%; }
.mrrp-table th:nth-child(3) { width: 22%; }
.mrrp-table th.is-right, .mrrp-table td.is-right { text-align: right; }
.mrrp-table tr:last-child td { border-bottom: 0; }
.mrrp-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, #fafbfc); }
.mrrp-modelCell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mrrp-modelName { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-modelId { color: var(--dsw-alias-label-tertiary, #8f959e); font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-bindCell { display: inline-flex; align-items: center; gap: 6px; }
.mrrp-profileCell { display: inline-flex; align-items: center; gap: 6px; }
.mrrp-profileScene { width: 150px; height: 28px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 6px; font-size: 12px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-text, #1a1d21); outline: none; }
.mrrp-combobox { position: relative; display: flex; flex-direction: column; min-width: 0; }
.mrrp-combobox-input { display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 6px; cursor: pointer; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-combobox-field { flex: 1; min-width: 0; border: none; outline: none; font-size: 12px; background: transparent; color: var(--dsw-alias-text, #1a1d21); }
.mrrp-combobox-value { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-text, #1a1d21); }
.mrrp-combobox-placeholder { color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-combobox-arrow { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8f959e); margin-left: 8px; flex: none; }
.mrrp-combobox-panel { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30; max-height: 220px; overflow-y: auto; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08); padding: 4px; }
.mrrp-combobox-option { padding: 6px 8px; font-size: 12px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-text, #1a1d21); }
.mrrp-combobox-option:hover, .mrrp-combobox-option.is-highlight { background: var(--dsw-alias-interactive-bg-hover, #f5f6f8); }
.mrrp-combobox-option.is-selected { color: var(--dsw-alias-brand, #3370ff); font-weight: 600; }
.mrrp-combobox-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-bindSelect { min-width: 130px; }
.mrrp-linkHint { display: inline-flex; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-muted { color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-rowActions { display: inline-flex; align-items: center; gap: 2px; }
.mrrp-search { display: flex; align-items: center; gap: 6px; min-width: 160px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-tertiary, #8f959e); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-search-input { flex: 1 1 auto; min-width: 0; min-height: 28px; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font: 13px/1 inherit; }
.mrrp-roleList, .mrrp-deptList { display: flex; flex-direction: column; gap: 8px; }
.mrrp-roleItem, .mrrp-deptItem { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 11px 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; }
.mrrp-roleItem-main, .mrrp-deptItem-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mrrp-roleItem-name, .mrrp-deptItem-name { font-size: 13px; font-weight: 650; }
.mrrp-roleItem-meta, .mrrp-deptItem-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mrrp-roleItem-desc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; }
.mrrp-roleItem-actions, .mrrp-deptItem-actions { display: flex; align-items: center; gap: 2px; }
.mrrp-defaultTag { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 11px; color: #8a5a00; background: #fff4d6; border: 1px solid #f3d98b; white-space: nowrap; }
/* 部门页：树形展开（点击部门展开子部门与部门内用户） */
.mrrp-deptTree { display: flex; flex-direction: column; gap: 2px; }
.mrrp-deptNode { display: flex; flex-direction: column; }
.mrrp-deptRow { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-fill-bg, #fff); min-width: 0; cursor: pointer; }
.mrrp-deptRow:hover { border-color: rgba(56,199,188,.45); }
.mrrp-deptCaret { width: 18px; flex: 0 0 18px; text-align: center; color: var(--dsw-alias-label-secondary, #646a73); cursor: pointer; user-select: none; font-size: 11px; line-height: 18px; }
.mrrp-deptCaret.is-empty { color: #c9cdd4; cursor: default; }
.mrrp-deptName { flex: 0 1 auto; min-width: 0; font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-deptStats { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; overflow: hidden; }
.mrrp-deptRow-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.mrrp-deptChildren { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.mrrp-deptUsers { display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px; }
.mrrp-deptUserRow { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); border-left: 2px solid rgba(56,199,188,.35); min-width: 0; }
.mrrp-deptUserName { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); flex: none; }
.mrrp-deptUserRole { color: var(--dsw-alias-label-tertiary, #8f959e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-deptUserRole.is-fallback { color: #0e8f84; }
.mrrp-deptUserId { margin-left: auto; flex: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-tertiary, #8f959e); word-break: break-all; }
.mrrp-twoCol { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.mrrp-checkGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; }
.mrrp-checkItem { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; min-height: 22px; }
.mrrp-checkItem input { width: 15px; height: 15px; accent-color: #38c7bc; flex: none; }
/* 分类弹窗：绑定模型选择器（搜索 + 分页） */
.mrrp-bindPanel { border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.mrrp-bindHead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-bindSearch { flex: 1; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; font-size: 12px; color: var(--dsw-alias-label-primary, #1f2329); background: transparent; }
.mrrp-bindSearch:focus { outline: none; border-color: #38c7bc; box-shadow: 0 0 0 2px rgba(56,199,188,.15); }
.mrrp-bindCount { flex: none; font-size: 12px; font-weight: 600; color: #0e8f84; white-space: nowrap; }
.mrrp-bindBody { max-height: 216px; overflow-y: auto; padding: 10px; }
.mrrp-bindGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.mrrp-bindItem { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px; font-size: 13px; cursor: pointer; min-width: 0; }
.mrrp-bindItem:hover { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.mrrp-bindItem.is-checked { border-color: #38c7bc; background: rgba(56,199,188,.08); }
.mrrp-bindItem input { width: 15px; height: 15px; accent-color: #38c7bc; flex: none; }
.mrrp-bindMeta { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.mrrp-bindMeta small { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.mrrp-bindFoot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-bindMuted { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-bindPages { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.mrrp-bindNav { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-1, #fff); cursor: pointer; }
.mrrp-bindNav:hover:not(:disabled) { border-color: #38c7bc; color: #0e8f84; }
.mrrp-bindNav:disabled { opacity: .45; cursor: not-allowed; }
.mrrp-bindAll { font-size: 12px; }
.mrrp-bindPageNo { min-width: 42px; text-align: center; }
.mrrp-bindEmpty { padding: 26px 12px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 角色弹窗：每个选中分类的模型配置卡片 */
.mrrp-roleCatList { display: flex; flex-direction: column; gap: 10px; }
.mrrp-roleCatItem { border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; padding: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-roleCatHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.mrrp-roleCatName { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-roleCatCount { font-size: 12px; color: #0e8f84; white-space: nowrap; }
.mrrp-userDeptChips { display: flex; flex-wrap: wrap; gap: 4px; }
/* 用户：ID / 角色回退 */
.mrrp-idStatic { display: flex; align-items: center; color: var(--dsw-alias-label-primary, #1f2329); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.mrrp-userId { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.mrrp-roleFallback { color: #0e8f84; font-size: 12px; }
/* 路由页：决策模型提供方卡片 */
.mrrp-card-head { display: flex; align-items: center; gap: 10px; }
.mrrp-providerList { display: flex; flex-direction: column; gap: 10px; }
.mrrp-providerCard { border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-providerHead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mrrp-providerName { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-formatBadge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.mrrp-format-laya { background: rgba(56,199,188,.12); color: #0e8f84; }
.mrrp-format-openai { background: rgba(61,116,240,.12); color: #3d74f0; }
.mrrp-format-generic { background: rgba(132,94,247,.12); color: #845ef7; }
.mrrp-providerState { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-providerActions { margin-left: auto; display: flex; gap: 6px; }
.mrrp-providerMeta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.mrrp-modelChips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.mrrp-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-chip button { border: 0; background: none; color: var(--dsw-alias-label-tertiary, #8f959e); cursor: pointer; padding: 0; font-size: 12px; line-height: 1; }
.mrrp-chip button:hover { color: #d92d20; }
.mrrp-modelAdd { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.mrrp-modelAdd .mrrp-bindSearch { flex: 1; }
.mrrp-testLine { margin-top: 10px; font-size: 12px; }
.mrrp-test-ok { color: #0e8f84; }
.mrrp-test-error { color: #d92d20; }
.mrrp-userName { font-weight: 600; }
.mrrp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 34px 16px; text-align: center; }
.mrrp-empty-icon { display: flex; color: var(--dsw-alias-label-tertiary, #8f959e); opacity: .7; }
.mrrp-empty-title { font-size: 14px; font-weight: 650; }
.mrrp-empty-desc { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; line-height: 18px; max-width: 320px; }
.mrrp-empty-action { padding-top: 8px; }
.mrrp-notice { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.mrrp-notice-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 30%, var(--dsw-alias-border-l2, #dfe1e5)); color: var(--dsw-alias-state-warn-primary, #d97706); }
.mrrp-kv { display: flex; flex-direction: column; gap: 8px; }
.mrrp-kvRow { display: flex; align-items: baseline; gap: 12px; font-size: 12px; line-height: 18px; }
.mrrp-kvKey { flex: 0 0 92px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.mrrp-kvPath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.mrrp-modal-overlay, .mrrp-drawerOverlay { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 18, 24, .38); display: flex; align-items: flex-start; justify-content: center; }
.mrrp-modal-overlay { align-items: center; padding: 24px; }
.mrrp-modal { max-width: 100%; max-height: 90vh; overflow: auto; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 12px 40px rgb(15 18 24 / 22%); }
.mrrp-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-modal-head h3 { margin: 0; font-size: 15px; font-weight: 700; }
.mrrp-modal-body { padding: 18px 16px; }
.mrrp-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-modal-actions { display: flex; gap: 8px; }
.mrrp-modal-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-drawerOverlay { align-items: center; justify-content: center; padding: 24px; }
.mrrp-floatCard { width: 420px; max-width: 92vw; max-height: 82vh; display: flex; flex-direction: column; background: var(--dsw-alias-bg-module-platform, #f7f8fa); border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 14px; box-shadow: 0 12px 40px rgb(15 18 24 / 22%); overflow: hidden; }
.mrrp-floatCard-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-floatCard-head .mrrp-brandRow { gap: 6px; }
.mrrp-floatCard-head .mrrp-brandText { font-size: 15px; font-weight: 700; }
.mrrp-floatCard-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.mrrp-drawer { width: 340px; max-width: 88vw; height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-module-platform, #f7f8fa); box-shadow: -12px 0 32px rgb(15 18 24 / 16%); }
.mrrp-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.mrrp-drawer-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.mrrp-drawer-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.mrrp-drawer-foot { padding: 14px 18px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-toasts { position: fixed; top: 16px; right: 16px; z-index: 1200; display: flex; flex-direction: column; gap: 8px; max-width: 320px; }
.mrrp-toast { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 18px; color: #fff; background: #26303a; box-shadow: 0 6px 20px rgb(15 18 24 / 20%); animation: mrrpToastIn .18s ease; }
.mrrp-toast-success { background: #1a9d63; }
.mrrp-toast-error { background: #d54941; }
.mrrp-toast-msg { word-break: break-word; }
.mrrp-toast .mrrp-btn-icon { color: rgba(255,255,255,.75); }
.mrrp-spinner { display: inline-block; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: mrrpSpin .7s linear infinite; }
@keyframes mrrpSpin { to { transform: rotate(360deg); } }
@keyframes mrrpToastIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (max-width: 900px) {
  .mrrp-topSplit, .mrrp-twoCol { grid-template-columns: 1fr; }
  .mrrp-formGrid { grid-template-columns: 1fr; }
  .mrrp-ruleRow { flex-wrap: wrap; }
  .mrrp-ruleField, .mrrp-ruleValue, .mrrp-ruleCat { flex: 1 1 100%; }
}
/* 插件详情页「打开 MRRP」按钮 */
.mrrp-pluginOpen {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 0 14px; height: 32px; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; cursor: pointer;
}
.mrrp-pluginOpen:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); border-color: var(--dsw-alias-border-l3, #c9cdd4); }
/* 路由决策日志页 */
.mrrp-logTable th:nth-child(1) { width: 15%; }
.mrrp-logTable th:nth-child(2) { width: 11%; }
.mrrp-logTable th:nth-child(3) { width: 17%; }
.mrrp-logTable th:nth-child(4) { width: auto; }
.mrrp-logTable th:nth-child(5) { width: 52px; }
.mrrp-logRow { cursor: pointer; }
.mrrp-logRow.is-open { background: rgba(56, 199, 188, .06); }
.mrrp-logTime { color: var(--dsw-alias-label-tertiary, #8f959e); font: 11.5px/16px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.mrrp-tag { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; font-weight: 600; white-space: nowrap; }
.mrrp-tag-ok { color: #0f8f63; background: rgba(26, 157, 99, .12); }
.mrrp-tag-warn { color: #b2540c; background: rgba(219, 128, 18, .14); }
.mrrp-tag-err { color: #c0392b; background: rgba(213, 73, 65, .12); }
.mrrp-tag-info { color: #2a5ac7; background: rgba(51, 112, 255, .10); }
.mrrp-logDetail { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mrrp-logModel { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-logText { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrrp-logExpand { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; white-space: nowrap; }
.mrrp-logRaw { margin: 0; padding: 12px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; max-height: 480px; overflow-y: auto; color: var(--dsw-alias-label-primary, #1f2329); }
/* 日志详情：从左侧滑出面板（覆盖表格左 2/3）；面板与表格同高，均不超出窗体可视范围 */
.mrrp-logArea { position: relative; max-height: calc(100vh - 200px); }
.mrrp-logArea .mrrp-tableWrap { max-height: inherit; overflow-y: auto; }
.mrrp-logPanel {
  position: absolute; left: 0; top: 0; bottom: 0; width: 66.66%;
  z-index: 6; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border-right: 1px solid var(--dsw-alias-border-l1, #eef0f3);
  border-radius: 10px 0 0 10px;
  box-shadow: 14px 0 28px -20px rgb(15 18 24 / 32%);
  transform: translateX(-105%);
  transition: transform .16s ease;
}
.mrrp-logPanel.is-open { transform: translateX(0); }
.mrrp-logPanel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.mrrp-logPanel-title { font-size: 13px; font-weight: 650; color: var(--dsw-alias-label-primary, #1f2329); }
.mrrp-logPanel-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px; }
.mrrp-logPanel .mrrp-logRaw { max-height: none; border-radius: 8px; }
`;

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const element = document.createElement('style');
      element.dataset.dshMrrp = 'styles';
      element.textContent = styles;
      document.head.appendChild(element);
      return () => element.remove();
    }

    /* ============================== 侧边栏图标 / 打开按钮 ============================== */
    function SidebarIcon({ size = 16 }) {
      // 侧边栏入口图标：宿主侧边栏对插件图标渲染历史上不稳定（钉卡片同样无图标）。
      // 用「纯 background 圆角方块」形状（渲染分界内最可靠），品牌青绿，替代文本箭头。
      return h('span', {
        className: 'mrrp-ico ico-sidebarTile mrrp-sidebarIcon',
        'aria-hidden': 'true',
        style: { width: size + 'px', height: size + 'px', fontSize: size + 'px', lineHeight: '1' },
      });
    }

    // 插件详情页的「打开 MRRP」按钮。DSH 靠 subject + packageName 匹配过滤，
    // 只有当前查看的插件是 dsh-mrrp 时才渲染，天然不会泄漏到其它插件页。
    function OpenMrrpAction({ subject, packageName, onOpen, t }) {
      if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null;
      if (subject.pkg?.name !== packageName) return null;
      if (subject.kind === 'row' && subject.row?.moduleName !== packageName) return null;
      return h('button', { type: 'button', className: 'mrrp-pluginOpen', onClick: onOpen }, t('打开 MRRP'));
    }

    /* ============================== 挂载 ============================== */
    exports.name = 'dsh-mrrp';
    exports.inject = ['slots', 'connection', 'locale'];

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-mrrp: locale');
      const t = ctx.locale.bind(NAMESPACE);
      const disposers = [installStyles()];

      let panelRegistered = false;
      let stopSidebar = null;
      let stopActions = null;
      let pageCtxRef = null;
      // 侧边栏默认可见：注册即出现，只有 host 显式配置 hide 才收起。
      // 避免「等 sidebar-entry.get RPC 成功才注册」——host RPC 未就绪时入口永远不出现。
      let sidebarVisible = true;
      // 根据 sidebarVisible 动态注册/注销 DSH 侧边栏的「MRRP」入口。
      // eslint-disable-next-line no-var
      var syncSidebar = null;
      syncSidebar = () => {
        const pc = pageCtxRef;
        if (!pc) return;
        if (sidebarVisible) {
          if (!stopSidebar) {
            stopSidebar = pc.slots.inject('sidebar.panellist', () => (
              pc.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 11,
                label: () => t('MRRP'),
                locale: NAMESPACE,
              }, SidebarIcon)
            ));
          }
        } else if (stopSidebar) {
          stopSidebar();
          stopSidebar = null;
        }
      };
      // 设置里改「侧边栏入口」后，立刻同步宿主侧边栏显隐（show/hide 即时生效，auto 回查 host）。
      const applySidebarMode = (mode) => {
        if (mode === 'show') { sidebarVisible = true; syncSidebar(); return; }
        if (mode === 'hide') { sidebarVisible = false; syncSidebar(); return; }
        rpcCall(ctx, 'sidebar-entry.get', {}).then((entry) => {
          sidebarVisible = entry?.visible !== false;
          syncSidebar();
        }).catch(() => undefined);
      };

      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], (pageCtx) => {
          pageCtxRef = pageCtx;
          const panels = pageCtx.slots.inject('main', () => {
            const unregisterPage = pageCtx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NAMESPACE,
              inject: () => ({ ctx, applySidebarMode }),
            }, MrrpPage);
            panelRegistered = true;
            // 插件详情页「打开 MRRP」按钮（DSH 靠 packageName 过滤，不会泄漏到其它插件页）。
            stopActions = pageCtx.slots.inject('plugins.detail.actions', () => (
              pageCtx.slots.register({
                name: 'plugins.detail.actions',
                id: 'dsh-mrrp-open',
                order: 21,
                locale: NAMESPACE,
                inject: () => ({
                  packageName: 'dsh-mrrp',
                  onOpen: () => pageCtx.layout.selectPanel(PANEL_ID),
                }),
              }, OpenMrrpAction)
            ));
            // 侧边栏默认已注册（sidebarVisible=true），异步读 host 配置：仅确认为 hide 时收起。
            syncSidebar();
            rpcCall(ctx, 'sidebar-entry.get', {}).then((entry) => {
              sidebarVisible = entry?.visible !== false;
              syncSidebar();
            }).catch(() => undefined);
            return () => {
              panelRegistered = false;
              stopActions?.();
              stopSidebar?.();
              stopSidebar = null;
              unregisterPage();
            };
          });
          disposers.push(() => panels());
        });
      }

      // 挂进 DSH 全局设置页：左侧出现「MRRP」入口，右侧渲染完整控制台。
      if (typeof ctx.slots?.inject === 'function' && typeof ctx.slots.register === 'function') {
        const stopSettings = ctx.slots.inject('settings.section', () => {
          const unregister = ctx.slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            order: 22,
            label: () => t('MRRP'),
            locale: NAMESPACE,
            inject: () => ({ ctx, applySidebarMode }),
          }, MrrpPage);
          return () => unregister();
        });
        disposers.push(() => stopSettings?.());
      }

      if (typeof ctx.provide === 'function') {
        ctx.provide('dshMrrpClient', Object.freeze({
          version: 1,
          render: () => h(MrrpPage, { ctx }),
          selectPanel: () => ctx.get?.('layout')?.selectPanel?.(PANEL_ID),
          panelRegistered: () => panelRegistered,
        }));
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch { /* ignore */ }
        }
      }, 'dsh-mrrp: client styles and panel');
    };

    exports.__internals = {
      MrrpPage,
      RouteConfigPage,
      DecisionConfigPage,
      CategoryConfigPage,
      ModelListPage,
      RolePage,
      DeptPage,
      UserPage,
      LogsPage,
      SettingsDrawer,
    };

    return module.exports;
  },
});
