# dsh-updater M5 设计(Web 面板:Settings 页 + Host↔Client RPC 桥)

日期:2026-09-13
状态:三项关键决策已与用户对齐(范围 B/自有 connection.rpc/零构建手写);配置编辑裁剪的四层论据经用户追问后查证修正(见 §3);待写实现计划
落点:本仓 `docs/superpowers/specs/`,延续 M1-M4 的 spec→plan→TDD 流程

## 1. 背景与目标

功能完整的自动更新插件需要 agent 对话以外的触达面。M5 为插件新增 **client 半边**:在 dsh web 的 Settings 里注册「Updater / 更新」页,展示更新状态并提供检查/更新/取消操作。Host 半边的 agent 工具、安全模型、配置不变。

竞品对照结论(2026-09-13 查证):**UI 不需要动 dsh 本体**。client 插件是官方一等公民——`packages/client/modules` 的 `__ModuleLoader__` 契约、`packages/extensions/cordis-client-runner` 浏览器运行时、`settings.section` slot 的官方示例(`slot-catalog.ts`)、官方自带的几十个 `ui-*` client 插件全部走同一机制。同场景参考实现:sogooday 的 dsh-updater(npm,settings.section + connection.rpc loopback + 零构建手写);dsh-market(纯插件实现整市场页)。真实成本不是改本体,而是 **client API 面的兼容耦合**,以 `engines.dsh` 声明 + 老宿主自我禁用应对(dsh-market 先例)。

## 2. 已锁定决策(用户确认)

1. **范围 = 状态 + 操作**:状态胶囊、最近结果、检查/更新/取消、pendingRestart 横幅;不含配置编辑(裁剪论据见 §3)
2. **桥 = 自有 connection.rpc**(authority: loopback):零外部依赖,状态/更新/取消一个通道全包,直接复用 Host 半边现有逻辑;不依赖 dsh-market(其 UPDATE-API-V1 为 beta 且要求装 market)
3. **构建 = 零构建手写**:client.js 手写 `__ModuleLoader__` factory + `React.createElement`(不用 JSX),仓库保持零第三方依赖、零构建步;UI 规模(单页卡片)可控

## 3. 范围裁剪:为什么不做配置编辑(查证修正版)

1. **职责重叠**:宿主 rc.7+ 的 Settings→Plugins 已有插件配置卡体系(`ui-settings-plugins` 的 configurable tab + `settings.plugin.item` slot),生态另有 dsh-settings-hub 聚合工具;自建编辑器造成三处入口,配置来源混乱
2. **写路径不确定性**(修正:初版「与 dsh-market 必然冲突」表述夸大):手写 `cordis.patch.yml` 会与 dsh-market 的 patch 写入构成 read-modify-write 竞态 + YAML 注释/格式保真问题;宿主 `ctx.remote.settings` 提供受管写(merge/replace + `settings/conflict` 错误语义),可消解冲突,但对 patch insert 行的写回语义未验证——是需 spike 的不确定性成本,非必然冲突
3. **自反性(最硬)**:`autoApply` 是插件自身运行开关;改配置→patch 变更→HMR recompose→`apply()` 重跑→`updateState`/`attemptedVersions` 内存态重建,可能打断进行中的更新 job
4. **YAGNI**:6 个低频字段,已有手改 patch / agent 工具 / 宿主配置卡三个入口

后续正确姿势(不在 M5):声明 settings descriptor 让宿主配置卡渲染字段,写路径走宿主受管 API——作为独立小增量,前提是 spike 验证 descriptor 机制覆盖第三方 patch 行插件。

## 4. 架构与文件结构

```
package.json          + dsh.client 声明(platform: web, inject: [包名级依赖边]) + engines.dsh 兼容声明
client.js(包根)       手写 factory:window.__ModuleLoader__.load({id:'dsh-updater', factory})
client/page.js        settings.section 注册 + 渲染(薄层,React.createElement,id:'dsh-updater')
client/view-model.js  纯逻辑:RPC 快照 → 视图模型(胶囊态/按钮可用态/横幅),node:test 可测
client/poller.js      纯逻辑:轮询节流(running 5s / idle 30s),node:test 可测
lib/client-rpc.js     RPC handler 工厂:get-status / start-update / cancel,
                      直接复用 collectWithUpdate / startUpdate / abort——与 agent 工具同源同门禁
index.js              + connection.rpc.handle('/rpc/dsh-updater', handler, {authority:'loopback'})
```

inject 具体包名边(对照 `api-catalog.ts` 与 sogooday 形态:slots/connection/locale 所在包)在实现期敲定。

**实现期 spike(第一步)**:宿主把 `/plugins/<name>/client.js` 映射到已安装包的哪个物理文件(包根约定还是 `exports` 字段,参照 `roster.ts` 的 URL 形态 + sogooday 的 exports 结构)——spike 结果决定 client.js 的落点,不影响以上骨架。

## 5. 页面行为

- **状态区**:harness 本体胶囊(形态、up-to-date / behind N / diverged / dirty)+ 每个 integration 一枚胶囊;数据源 `get-status` 快照(与 `dsh_update_status` 同构)
- **操作区**:「检查更新」「一键更新」「取消」三按钮,语义与 agent 工具完全一致(同一 `updateState.begin` 互斥、diverged/dirty 拒绝、绝不代重启);running 时展示流水 log;更新中其余按钮相应禁用
- **横幅**:`update.pendingRestart=true` 时顶部常驻「重启 dsh 生效」提示
- **双语**:跟随 `locale` 服务,中英两份文案

## 6. RPC 契约

通道 `/rpc/dsh-updater`,三端点,全部 loopback:

| 端点 | 请求 | 响应 | 语义 |
|---|---|---|---|
| `get-status` | `{}` | collectWithUpdate 快照(shape/summary/checks/update) | 与 `dsh_update_status` 同构 |
| `start-update` | `{}` | `{started:true,jobId}` 或 `{started:false,reason}` | 与 `dsh_update_run` 同门禁(已运行/无可更新即拒) |
| `cancel` | `{}` | `{cancelled,reason?}` | 与 `dsh_update_cancel` 同语义 |

错误走宿主 connection.rpc 的既有错误协议(实现期对齐具体形状);client 轮询 `get-status` 刷新。UI 触发与 agent 触发共用 `updateState.begin` 互斥,两侧天然互斥。

## 7. 兼容与失败处理

- `engines.dsh` 声明最低宿主版本(具体值实现期对照用到的 client API 定,参考 dsh-market 的 rc.6+ 底线);老宿主上 client 半边自我禁用并在 console 说明,Host 半边三个 agent 工具不受影响
- RPC 不可达/超时 → 页面错误态 + 重试按钮,不弹窗
- 一键更新失败 → 展示 pipeline 各步结果(数据源已有 steps 结构)

## 8. 测试与验收

- Host 端:`lib/client-rpc.js` 纯逻辑 node:test(注入假 deps,沿既有风格)
- Client 端:`view-model.js` / `poller.js` 纯逻辑 node:test;DOM 渲染薄层不做自动化测试
- **活体验收**(M2/M4 同款):重启后真实页面走一遍——状态胶囊正确、一键更新到 pendingRestart、取消演练(启动即取消→killed→门禁重开)、老宿主自禁用路径
- 全量回归(现有 80+ 测试)保持绿

## 9. 非目标

配置编辑(§3,后续走宿主配置卡方向)、代重启(spec §4 既有约束)、M3 npm 形态更新、多主题/外观定制、除 Settings 页外的其他 UI 位(侧栏/气泡等)。
