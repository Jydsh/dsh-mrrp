# dsh-mrrp

MRRP（Model Routing & Resource Planning）控制台：DSH 的模型路由与管理插件。

管理**模型分类**、**路由配置**、**决策模型配置**、**角色 / 部门** 与 **用户**，让不同角色 / 部门的请求路由到指定分类下的模型。

- 版本：2026.11.04
- 兼容：DSH 0.2.1-rc.2（profiles: web / desktop）
- 协议：TS 优先，client 侧混合 JS（零 JSX，`__ModuleLoader__.load` + 手写 `h()`）

## 功能

| 页面 | 能力 |
| --- | --- |
| 模型分类 | 上下布局：上左 = 路由配置（策略 / 负载均衡 / 超时 / 重试 / 兜底 / 故障切换 / 启用开关）；上右 = 模型分类列表（新建 / 编辑 / 删除 / 默认分类保护 / 选中高亮）；下 = 整宽模型列表（搜索 / 刷新 / 每行“未分类 ↔ 分类”绑定下拉） |
| 路由配置 | **决策模型路由**：启动决策模型开关 / 决策模型（Laya）/ 兜底模型（**可搜索下拉框**：输入即模糊搜索模型 key / 名称 / 提供方，键盘 ↑↓ + Enter 选择）/ 未注册用户策略 / 渠道。启用后插件向 DSH 对话暴露虚拟模型「MRRP 智能路由」，选中即按发送者用户权限路由真实模型回复（判定问题插件内置，无需配置） |
| 决策模型配置 | 决策模型提供方绑定：新增 / 编辑 / 删除 / 测试连接 / 获取模型，支持 laya-server、OpenAI 兼容、通用 API 三种格式 |
| 角色部门 | 双栏：角色 + 部门（新建 / 编辑 / 删除；角色 ↔ 部门多对多双向同步，任一页配置另一页自动显示；角色多选模型分类，每个分类可单独勾选角色可用的模型，**可勾选范围 = 该分类在「模型分类配置」页已绑定的模型**；角色列表可设**唯一「默认角色」**——dsh-im 新同步用户自动赋该角色，切换默认角色会提示原默认角色；部门为树形——点击部门展开子部门与部门内用户（用户只在**其直接绑定**的部门下显示，上级部门不汇总显示），新建 / 编辑可选上级部门收纳为子部门） |
| 用户 | 用户表格 + 搜索 + CRUD（ID = dsh-im 的 senderId 唯一标识；绑定角色 / 多部门；未绑角色时自动使用所属部门绑定的角色） |
| 模型列表（模型分类页下） | 模型搜索 / 刷新 / 分类绑定；每行可维护**模型画像**（类型：推理 / 对话 / 代码 / 视觉 / 长文本 / 多模态 / 工具调用 / 快速 / 其他；擅长场景）——**覆盖分类画像**，作为 Laya 模型路由决策的类型依据 |
| 日志管理 | 侧边栏「日志管理 → 日志」：路由决策日志（`route-decision.log`）列表，最新在前；「详情」从左侧滑出占 2/3、与日志区同高且不超窗体可视范围，原始 JSON 内部滚动；日志自动清理 30 天前的记录 |
| 设置抽屉 | 侧边栏入口 auto / show / hide + 插件信息 / 模型统计 / 配置路径 / 模型发现状态 |

侧边栏可折叠；深色青绿（#38C7BC）为原型视觉基调，DSH 内适配浅色主题（`--dsw-alias` 变量）。

## 安装

从 [GitHub Releases](https://github.com/Jydsh/dsh-mrrp/releases) 下载对应版本的 `dsh-mrrp-<version>.tgz` 安装包，按你的 DSH 环境执行：

### 桌面版

```bash
dsh plugin --profile desktop add ./dsh-mrrp-2026.11.04.tgz
```

### Web 版

```bash
dsh plugin --profile web add ./dsh-mrrp-2026.11.04.tgz
```

> `dsh plugin` 必须显式指定 `--profile`（DSH 的插件管理命令，转发给对应 profile 的 pnpm）。安装后**重启 DSH**（桌面版重启桌面端、Web 版重启 Web 端）插件即生效。

### 源码目录（开发模式，跳过打包）

```bash
dsh plugin --profile desktop add D:/dsh/dsh-mrrp
```

安装完成后，在 DSH 侧边栏找到 **MRRP** 进入控制台：先到「模型分类」页创建分类并绑定模型 →「角色部门」页建角色并勾选分类模型 →「决策模型配置」页新增并启用 Laya 提供方 →「路由配置」页启动决策模型路由并选择兜底模型 → 对话模型选择器选中「MRRP 智能路由」即可按用户权限路由。

### 版本检查与更新

打开 MRRP 控制台时会**自动检查 GitHub 最新 Release**（读取 `api.github.com/repos/Jydsh/dsh-mrrp/releases/latest`，失败回退 `releases.atom`）；有新版本时顶部版本号变为 `v当前 ↑ v最新` 并出现更新横幅，点击版本号或横幅按钮**复制更新命令**，执行后重启 DSH 生效：

```bash
# 以桌面版为例（命令会按当前 profile 自动生成）
dsh plugin --profile desktop add github:Jydsh/dsh-mrrp#v<最新版本>
```

顶部版本号也可随时点击手动检查更新。仓库路径默认指向本插件仓库 `Jydsh/dsh-mrrp`；不同插件仓库不同，可在 `config.json` 增加 `updateRepo` 字段（如 `"updateRepo": "Jydsh/dsh-mrrp"`）覆盖检查来源。

## 架构

```
host（TS，lib/*.ts → dist/）
  ├─ models.ts       只读发现 ctx.llm 模型（listProviders / listModels），绝不拦截主链路
  ├─ store.ts        ~/.dsh/integrations/dsh-mrrp/config.json 持久化（先写 .tmp 再 rename，原子写）
  ├─ rpc.ts          POST /api/mrrp 管理通道，22 个方法
  ├─ route-engine.ts 会话发送者映射 + 目标模型决策：订阅 DSH 会话事件（观察）记录「会话 → 发送者」；按用户（角色 + 部门）分类模型并集去重，候选多个时用内置判定问题（builtinModelChoiceQuestion）请 Laya 决策
  ├─ route-adapter.ts 决策模型路由 adapter：注册到 ctx.llm.registerAdapter(['mrrp'])，暴露虚拟模型「MRRP 智能路由」；stream 内解析发送者 → 决策真实模型 → ctx.llm.stream 代理转发
  └─ index.ts        apply：store.load → installRpc(ctx.inject(['connection','llm'])) → imRouting.start() → registerAdapter → effect dispose → provide dshMrrpClient

client（JS，lib/client.js，__ModuleLoader__.load 打包进 DSH）
  ├─ 五页导航（路由配置 / 决策模型配置 / 模型分类 / 角色部门 / 用户）+ 可折叠侧边栏 + 设置抽屉
  └─ 经 ctx.connection.rpc.call('/api','mrrp',{method,payload},signal) 调用 host
```

## RPC 通道

- 路径：`POST /api/mrrp`（`connection.fetch.register`，`requestBody: 'buffered'`）
- 请求：`{ type:'client-request', rpcId, method:'mrrp', payload:{method, payload} }`
- 响应：`{ type:'server-response', rpcId, result:{ ok, value | error:{code,message,details} } }`

### 方法

| 方法 | 说明 |
| --- | --- |
| `status` | 插件状态 / 模型统计 / 配置统计 / 模型发现异常 |
| `providers.list` / `models.list` | 只读列出提供方与全部已发现模型 |
| `config.get` / `config.save` | 读取 / 覆盖全量配置 |
| `categories.list / create / update / delete / bind / unbind` | 分类管理（同名去重 `duplicate-name`；默认分类受保护 `default-protected`；一个模型只属一个分类） |
| `route.get` / `route.save` | 路由配置（含 `imRoute` 决策模型路由配置） |
| `route.im.status` | 决策模型路由引擎运行状态（订阅 / 启用 / 决策模型 / 映射会话数 / 最近一次映射） |
| `roles.list` / `roles.save` | 角色（含部门列表；保存时按 `deptIds` 反向推导 `dept.roleIds` 实现双向同步） |
| `depts.list` / `depts.save` | 部门（含角色 / 用户列表；保存时按 `roleIds` 反向推导 `role.deptIds` 实现双向同步；`parentId` 构建部门树，悬空上级自动提升为顶级，循环引用会被拒绝） |
| `users.list` / `users.save` | 用户（含角色 / 部门；`deptIds` 支持多部门；列表自动把 dsh-im 首次出现的发送者补为缺失用户） |
| `users.resolve` | 按 senderId 解析：不带 senderId 返回 dsh-im 发送者列表；带 senderId 解析姓名，用户表不存在时默认自动创建（`create:false` 仅解析） |
| `users.syncIm` | 手动触发 dsh-im 自动同步，返回 `{created, users, roles, depts}` |
| `sidebar-entry.get` / `sidebar-entry.set` | 侧边栏入口 auto / show / hide |
| `decision.list` | 决策模型提供方列表 |
| `decision.save` | 新增 / 更新决策模型提供方（`{ provider }`，无 id 自动生成） |
| `decision.delete` | 删除决策模型提供方（`{ id }`） |
| `decision.fetch` | 拉取模型列表：openai→`GET {base}/v1/models`、generic→`GET {base}/models`、laya→返回内置检查点（manual） |
| `decision.test` | 测试连通性：laya→真实 `POST /v1/systemone`、其余→拉列表，返回 `{ok,message,latencyMs}` |

## dsh-im 用户打通

- **唯一标识**：用户 `id` 直接使用 dsh-im 对话里的 `senderId`（钉钉场景即 staffId），不再强制 `usr_` 前缀；可解析出该用户的姓名（`sender_name`）。
- **自动建用户**：插件后台**只读轮询**（默认每 60s，`config.autoSyncIm=false` 可关闭）dsh-im 群历史库，首次出现的发送者自动创建用户（id = senderId、姓名 = sender_name、角色 / 部门留空）。用户页「同步 dsh-im」按钮可手动触发。
- **自动添加默认角色**：在「角色部门 → 角色」列表可把某个角色设为**唯一默认角色**（金色徽标标注；切换时提示原默认角色；默认角色禁止直接删除）。dsh-im 新同步 / 自动创建的用户自动赋该默认角色（走「直接角色」显式授权路线）；已存在用户不受影响；未设默认角色时新用户不赋。
- **新建 / 编辑弹窗**：新增「ID」字段（新建时手动填写 senderId）；原「用户名」改为「姓名」。
- **角色回退**：用户可单独绑定角色；未绑定时自动使用其所属部门绑定的角色（多部门取全部部门角色的并集，仅用于展示说明）。
- **不拦截主链路**：全程只读 dsh-im 数据库，不注册 hook / 中间件；消息入库（由 dsh-im 自身完成）后，下一次轮询即自动补用户。

## 决策模型路由（adapter 暴露虚拟模型）

「路由配置」页的「决策模型路由」卡片启用（**启动决策模型**）后，插件通过宿主 `ctx.llm.registerAdapter` 把虚拟模型 **「MRRP 智能路由」** 暴露到 DSH 对话的模型选择器（dsh-im / DSH 对话均可见）。对话选中该模型后，生成请求进入插件的 adapter，按会话发送者权限决策真实模型并代理回复：

```
对话选中「MRRP 智能路由」
  → adapter 用会话 id 查「会话 → 发送者」映射（插件订阅 session/event 观测记录，含 senderId / senderName）
  → senderId 对应用户表 id
  → 用户可用模型 = 用户单独角色 + 所属部门绑定角色 的 categoryBindings（分类内模型并集，去重）
  → 候选唯一：直接使用；候选多个：内置判定问题请 Laya 决策模型（在「决策模型配置」页绑定的提供方）选一个
  → 插件代理该真实模型（ctx.llm.stream）生成回复
  → 未注册用户 / 未绑定分类 / 决策失败 → 兜底模型；未注册用户策略=ignore → 对话明确提示未注册
```

- **暴露虚拟模型**：无需用户在对话里配置，插件注册的提供方 `mrrp` 下出现模型 `route`（显示名「MRRP 智能路由」）。未启动决策模型时，选中该模型也会按兜底模型转发（未配兜底则明确报错）。
- **决策模型（Laya）**：仅支持 `format=laya` 的提供方（本地 systemone / 0G decisions）。**候选模型的选择判定问题由插件内置**（`builtinModelChoiceQuestion`：根据消息内容从候选模型列表里选一个），用户不再配置判定问题与规则映射。
- **性能**：① 会话级决策缓存（sticky）——同一会话连续对话复用已决策模型，不再重复调用 Laya；发送者变化 / 路由配置变化 / 缓存 10 分钟过期时自动重新决策；② 候选选择用 6s 短超时——Laya 慢或不可达时快速落兜底，避免用户干等；③ 候选唯一时直接使用，不调决策模型；④ 候选池为空（用户无任何绑定分类模型）时直接使用兜底模型，不发起 Laya 决策。
- **决策问题完善**：发送给 Laya 的候选模型带**类型与擅长场景画像**——优先取「模型列表」页手动画像（`modelProfiles`），未配置则回退该模型所在分类的「名称 + 描述」；判定指令明确按问题语义 / 复杂度 / 是否涉及代码·视觉·长文本 / 所需推理深度决策，并附带**发送者姓名**与**候选授权来源**（直接角色 N 个 / 部门继承 M 个）；要求 Laya 输出一句简短 `reasoning`（选择理由），随路由日志记录，便于核对决策是否合理。
- **配置即时效**：决策缓存指纹覆盖影响候选池的全部配置（分类 / 角色 / 部门 / 用户 / 模型画像 / 默认角色），控制台任一改动保存后，已缓存会话立即失效并重新决策，无需等待 10 分钟缓存过期。
- **路由决策日志**：与 `config.json` 同目录的 `route-decision.log`（append JSON 行）。每次生成请求记录完整链路：会话 / 发送者 / 用户命中 / 候选池 / 决策来源（user=laya=fallback=unknown-fallback）/ 最终模型 / **Laya 选择理由（reasoning）**；`decide-before`（发送给 Laya 的 state 与 questions）/ `decide-after`（Laya 原始响应）/ `decide-error` 记录决策模型的请求与响应——用于确认「按用户权限路由」是否真实生效、Laya 决策是否命中。会话发送者观测（`scope: im-route`）也写入同一文件：订阅成功 / 每次映射 / 事件被拒原因（首个样本，含事件 type 与字段结构）——映射未命中时据此定位是事件未到达还是形状不匹配。**控制台侧边栏「日志管理 → 日志」直接查看**：最新在前（默认 200 条 / 上限 1000 条），详情面板从左侧滑出（占日志区 2/3、与日志区同高且不超窗体可视范围、内部滚动）；日志 **30 天自动清理**（写入时 6 小时节流触发一次，启动时清一次）。
- **会话事件兼容**：会话发送者映射同时识别 `user/message`（dsh-im）与 `agent/inbox/spliced` / `agent/inbox/inserted`（DSH agent inbox：inserted 最后一条 / data.message）。消息无 senderId（如 agent 自身注入）或纯删除（outcome=canceled）不建映射；渠道白名单在 channel 缺失时不拦截。
- **dsh-dingtalk 桥会话映射**：DSH agent inbox 的 user 消息不携带发送者身份（source 只有 kind:"user" + rpcId），而 dsh-dingtalk 桥在 `~/.dsh/integrations/dsh-dingtalk/bots/<botId>/state.json` 持久化了 `p2p:<staffId> -> DSH sessionId` 映射。插件只读该 state.json（写入中途重试一次、静默降级），把「DSH 会话 → 钉钉发送者」建立起来；事件观测与桥映射双来源取并集，adapter 解析发送者时优先事件观测、其次桥映射。诊断日志中 `会话映射（dingtalk 桥）：N 个会话` 表示桥映射已加载。
- **兜底模型**：`provider:id`，从已发现模型列表选择；用户未注册 / 未绑定分类 / 决策失败时使用。
- **未注册用户**：`ignore` = 对话明确提示「未注册用户，无法路由」；`fallback` = 使用兜底模型。
- **渠道**：默认 `dingtalk`；可配置多个渠道（逗号分隔），空 = 全部 dsh-im 渠道。
- **会话→发送者映射**：插件只订阅 `session/event`（观察），把「会话 id → 最近发送者」记入内存映射；对真实 dsh-im 事件做了兼容（senderId 在消息顶层、source 可能是懒函数、kind 缺失时由 senderId 强信号把关）。会话 id 与宿主生成请求的 `options.sessionId` 不一致时提供包含匹配兜底。
- **安全**：adapter 是宿主正规的提供方扩展点，事件观测只读不拦截；转发仅改 provider/model 字段，不修改消息内容；任何异常都带明确消息呈现给对话，绝不静默走错模型。

## 配置存储

`~/.dsh/integrations/dsh-mrrp/config.json`（可用 `DSH_HOME` 覆盖主目录）。结构：

```json
{
  "version": 1,
  "route": { "active": true, "strategy": "category", "lb": "round-robin",
             "weights": {}, "fallback": "random", "timeoutMs": 60000,
             "retries": 0, "failover": true,
             "imRoute": { "enabled": false, "decisionProviderId": "",
                          "questions": {}, "rules": [],
                          "fallbackModel": "", "unknownUser": "ignore",
                          "channels": ["dingtalk"] } },
  "categories": [ { "id": "cat_xxx", "name": "深度推理", "desc": "", "modelIds": [], "isDefault": true } ],
  "roles": [], "depts": [], "users": [],
  "sidebar": { "mode": "auto" },
  "decisionProviders": [
    { "id": "dp_xxx", "name": "Laya 本地", "format": "laya",
      "baseUrl": "http://127.0.0.1:8000", "apiKey": "",
      "modelNames": ["english", "multilingual"], "categoryId": "cat_xxx",
      "enabled": true, "createdAt": "", "updatedAt": "" }
  ]
}
```

> 说明：`route` 下除 `imRoute`（决策模型路由配置）外的字段（`active / strategy / lb / weights / fallback / timeoutMs / retries / failover`）为旧版「路由模型配置」的历史遗留，当前版本 UI 已移除，业务链路不再读取；保留仅为兼容既有 config.json，可安全忽略。

## 决策模型提供方（laya_decide）

在「决策模型配置」页维护提供方：`API 地址 + API 密钥（可空）` 获取 / 手动维护模型。

支持的接口格式：

| format | 模型列表 | 决策调用 |
| --- | --- | --- |
| `laya`（本地 `endpoint: systemone`） | 无 `/v1/models`，手动输入检查点（english / multilingual / typed-decisions，按钮可一键填入） | `POST {baseUrl}/v1/systemone`（TypeSafe Jev 协议） |
| `laya`（0G 云端 `endpoint: decisions`） | 同上（内置检查点可一键填入） | `POST {baseUrl}/v1/decisions`，请求体自动带 `model: "laya"` |
| `openai` | `GET {baseUrl}/v1/models` | ——（拉列表后手填/保存） |
| `generic` | `GET {baseUrl}/models` | —— |

Laya 提供方可在弹窗「调用端点」选择：**本地 laya-server**（`http://127.0.0.1:8000` → `/v1/systemone`）或 **0G 云端**（`https://router-api.0g.ai` → `/v1/decisions`）。0G 云端调用示例：

```bash
curl "https://router-api.0g.ai/v1/decisions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{ "model": "laya", "state": "...", "questions": { ... } }'
```

鉴权：请求头 `Authorization: Bearer <apiKey>`；服务端未设置密钥时留空（不发送该头）。测试连接按钮：laya 走一条真实决策 ping，其余走模型列表拉取。

### laya_decide 工具

插件启动时向 DSH 注册 `laya_decide` 工具（运行时不提供 tools 时仅告警跳过，不影响控制台与 DSH 启动）。参数：

```json
{ "state": "待判断的文本（必填）",
  "questions": { "verdict": { "type": "choice",
                               "instructions": "…",
                               "criteria": { "yes": "…", "no": "…" } } } }
```

- `state`：字符串（或对象，Jev 会按原文判断）。
- `questions`：省略时使用默认简单 choice（yes/no）。
- 三种 primitive：`choice`（criteria = 至少两个选项的对象）、`score`（criteria = 至少两个档位的数组）、`noul`（criteria 可省）。
- 返回 Laya `/v1/systemone` 原始 JSON（`{ model, answers, usage }`）。

提供方解析优先级：控制台已配置且启用的 `laya` 提供方 → `cordis.patch.yml` 中 `config.laya` 覆盖项（未在控制台配置时的兜底）。

### cordis.patch.yml 配置片段

安装方式（`dsh plugin add ./dsh-mrrp-2026.11.04.tgz`）会自动写入 `cordis.patch.yml` 的 `insert: [{ id: dsh-mrrp }]`。如需用配置文件直接声明 Laya 服务（未在控制台新增提供方时的兜底），在插件的 `config` 下追加：

```yaml
# DSH 配置目录下（如 ~/.dsh/profiles/desktop/cordis.patch.yml）
insert:
  - id: dsh-mrrp
    config:
      laya:
        baseUrl: http://127.0.0.1:8000   # 本地 laya-server 默认 0.0.0.0:8000；云端填 https://router-api.0g.ai
        apiKey: ""                        # 可选；LAYA_API_KEY 未启用时留空
        endpoint: systemone               # 可选：systemone（本地 /v1/systemone，默认）| decisions（0G 云端 /v1/decisions）
```

控制台里新增并启用的 Laya 提供方优先于该片段。

## 开发

```bash
pnpm install
pnpm build      # tsc 编译 host（lib/*.ts → dist/）
pnpm test       # node --test 冒烟测试（store + RPC 全通道）
pnpm pack       # 打 tgz 发布包
```

## 安全边界

- **绝不注册 hook / 中间件拦截 DSH 主链路**——模型只读发现 + 管理 RPC 通道。
- 未实现 `plugins.detail.actions` 挂载，避免“打开”按钮泄漏到其它插件页面。
