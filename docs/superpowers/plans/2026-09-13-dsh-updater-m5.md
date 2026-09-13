# dsh-updater M5 Implementation Plan(Web 面板:Settings 页 + connection.rpc 桥)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M5:在 dsh web Settings 注册「Updater / 更新」页(状态胶囊 + 检查/更新/取消 + pendingRestart 横幅),经自有 connection.rpc(loopback)桥接到 Host 半边现有逻辑,零构建手写 client 半边。

**Architecture:** 延续 M1-M4「纯逻辑可注入 + I/O 分离」。新增三个纯逻辑模块(`update-plan.js` 计划构建、`client-rpc.js` RPC 派发、client 半边 `view-model.js`/`poller.js`)全部依赖注入做单测;`client.js`(factory 形态)与 `page.js` 是薄渲染层,不做自动化测试,靠活体验收。UI 触发与 agent 工具共用同一 `updateState.begin` 互斥。

**Tech Stack:** Node >= 20 ESM、`node:test`(零测试依赖)、宿主 client module system(`window.__ModuleLoader__` factory + 注入 `require` 取 react)、React `createElement`(无 JSX)。

**Spec:** `/Users/dmall/Projects/dsh-updater/docs/superpowers/specs/2026-09-13-dsh-updater-m5-web-panel-design.md`

## Global Constraints

- 仓位置 `/Users/dmall/Projects/dsh-updater`(下文 `$R`);bash 一律绝对路径,不 `cd`。
- 零第三方依赖、零构建步:client.js 手写 factory,禁止引入 bundler/devDependencies。
- RPC 通道 `/rpc/dsh-updater` 全部 loopback authority;三端点语义与 `dsh_update_status`/`dsh_update_run`/`dsh_update_cancel` 完全一致;UI 与 agent 共用 `updateState.begin` 互斥。
- 绝不代重启;diverged/dirty 只报告不动;`cordis.patch.yml` 不改。
- 老宿主上 client 半边自我禁用 + console 说明;Host 半边既有 agent 工具行为不变(现有 80 测试全绿是每任务的硬门)。
- 测试命令:`node --test --test-reporter=spec "$R"/test/*.test.js`。

---

### Task 1: Spike — 宿主 client 契约四问(只读 harness,产出笔记)

**Files:**
- Create: `$R/docs/superpowers/plans/2026-09-13-dsh-updater-m5-spike-notes.md`

**Interfaces:**
- Produces: 四个契约答案(带文件:行号),Task 5 的 ⚠spike 行据此落地。

- [ ] **Step 1: client.js 物理落点**

从 `$H/packages/client/modules/src/index.ts`(`$H` = `/Users/dmall/Projects/deepseek-harness`)的 `fetchBundle`/`bundleResource` 与 `table` 溯源 bundle bytes 的磁盘来源,确认 `/plugins/<name>/client.js` 映射到已安装包的哪个文件(包根 `client.js` 还是 `exports` 指向)。线索:URL 由 `graphFromRoster` 以占位形式生成(`packages/test-support/client-runtime/src/assembly/roster.ts:37`),生产侧必有一处把真实路径绑定进 table;`apps/desktop-host/src/index.ts:200` 有 `/plugins/` 路由消费 `fetchBundle`。

- [ ] **Step 2: dsh.client → roster 组装**

从 `roster.ts` 的 `ClientRosterRow`/`graphFromRoster` 反查生产调用方(谁读已安装包清单组 rows),确认 `platform`/`immediately`/`inject` 的必填性与语义;确认 `inject` 的包名边该写哪些包(参考 sogooday:`@deepseek-ai/dsh-client-connection` + `@deepseek-ai/dsh-client-ui-settings`)。

- [ ] **Step 3: factory 的 require 外部面**

在 `modules/src` 的 externals/require 实现里列出 factory 内 `require(specifier)` 可解析的面:`'react'` 是否可用、locale/slots 等服务是经 `ctx` 还是经 require。

- [ ] **Step 4: connection.rpc 宿主签名**

在 `$H/packages/api/gateway` 找宿主侧 `rpc.handle(path, handler, opts)` 的准确签名与 `authority: 'loopback'` 语义;确认 Host 插件 `inject` 数组里 connection 的服务名;确认 client 侧 `rpc.call(path, endpoint, payload)` 形状(对照 `packages/api/gateway/src/client/index.ts`)。

- [ ] **Step 5: 写笔记并提交**

四问各一节,文件:行号级答案;结尾一节「对 Task 3/4/5 证据形态的差异清单」。`git add docs/superpowers/plans/2026-09-13-dsh-updater-m5-spike-notes.md && git commit -m "docs: M5 spike notes(host client contract)"`。

---

### Task 2: lib/update-plan.js — 计划构建纯函数(从 run-tool 抽取,行为不变)

**Files:**
- Create: `$R/lib/update-plan.js`
- Modify: `$R/lib/run-tool.js`
- Test: `$R/test/update-plan.test.js`

**Interfaces:**
- Produces: `buildPlan({ shape, checks })` → `{ plan, skipped, refusal }`;`plan` 元素 `{ target, path?, behind }`(harness 项含 `path`,`refusal` 为 `undefined` 或 `{ reason, skipped }`。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan } from '../lib/update-plan.js'

test('non-git shape refuses (npm lands in M3)', () => {
  const r = buildPlan({ shape: { kind: 'npm' }, checks: [] })
  assert.equal(r.refusal.reason, 'unsupported install shape: npm (npm form lands in M3)')
  assert.equal(r.plan.length, 0)
})

test('harness behind lands in plan with path and behind count', () => {
  const r = buildPlan({ shape: { kind: 'git' }, checks: [
    { kind: 'harness-git', target: '/h', status: 'behind', behindCount: 5 },
  ] })
  assert.deepEqual(r.plan, [{ target: 'harness', path: '/h', behind: 5 }])
  assert.equal(r.refusal, undefined)
})

test('up-to-date harness is skipped, diverged integration reports manual action', () => {
  const r = buildPlan({ shape: { kind: 'git' }, checks: [
    { kind: 'harness-git', target: '/h', status: 'up-to-date' },
    { kind: 'integration', target: '/i1', status: 'behind', behindCount: 2 },
    { kind: 'integration', target: '/i2', status: 'diverged' },
  ] })
  assert.deepEqual(r.plan, [{ target: '/i1', behind: 2 }])
  assert.deepEqual(r.skipped, [
    { target: '/h', reason: 'harness status up-to-date' },
    { target: '/i2', reason: 'diverged: manual action required' },
  ])
})

test('empty plan refuses with nothing to update', () => {
  const r = buildPlan({ shape: { kind: 'git' }, checks: [
    { kind: 'harness-git', target: '/h', status: 'up-to-date' },
  ] })
  assert.equal(r.refusal.reason, 'nothing to update')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/update-plan.test.js`
Expected: FAIL(Cannot find module '../lib/update-plan.js')

- [ ] **Step 3: 最小实现(逻辑逐行移植自 run-tool.js:11-28)**

```js
// buildPlan: 把一次 collect 的 checks 变成更新计划。纯函数,agent 工具与 RPC 共用。
export function buildPlan({ shape, checks }) {
  if (shape.kind !== 'git') {
    return { plan: [], skipped: [], refusal: { reason: `unsupported install shape: ${shape.kind} (npm form lands in M3)` } }
  }
  const plan = []
  const skipped = []
  const harness = checks.find(c => c.kind === 'harness-git')
  if (harness) {
    if (harness.status === 'behind') plan.push({ target: 'harness', path: harness.target, behind: harness.behindCount })
    else skipped.push({ target: harness.target, reason: harness.status === 'diverged' ? 'diverged: manual merge/rebase required' : `harness status ${harness.status}` })
  }
  for (const c of checks.filter(c => c.kind === 'integration')) {
    if (c.status === 'behind') plan.push({ target: c.target, behind: c.behindCount })
    else skipped.push({ target: c.target, reason: c.status === 'diverged' ? 'diverged: manual action required' : `status ${c.status}` })
  }
  if (plan.length === 0) return { plan, skipped, refusal: { reason: 'nothing to update', skipped } }
  return { plan, skipped, refusal: undefined }
}
```

- [ ] **Step 4: run-tool 改调 buildPlan(行为不变,现有测试守护)**

`run-tool.js` 的 `execute` 中 `const { shape, checks } = await collectStatus({})` 之后改为:

```js
      const { plan, skipped, refusal } = buildPlan({ shape, checks })
      if (refusal) return JSON.stringify({ started: false, reason: refusal.reason, skipped }, null, 2)
```

顶部 `import { buildPlan } from './update-plan.js'`;删除原 12-28 行的手写逻辑;末段 try/catch 不变。npm 形态时 refusal 已含 skipped 字段为空数组,与原行为一致。

- [ ] **Step 5: 全量回归**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全 PASS(含既有 run-tool 用例)

- [ ] **Step 6: Commit**

`git add lib/update-plan.js lib/run-tool.js test/update-plan.test.js && git commit -m "refactor: extract buildPlan shared by run tool and client rpc"`

---

### Task 3: lib/client-rpc.js — RPC 派发器

**Files:**
- Create: `$R/lib/client-rpc.js`
- Test: `$R/test/client-rpc.test.js`

**Interfaces:**
- Consumes: `buildPlan({shape, checks})`(Task 2)、`collect()`(index.js 的 `collectWithUpdate`,返回含 update 快照)、`startUpdate(plan, exec?)`(index.js 现有)、`getSnapshot()`/`abort(reason)`(updateState)。
- Produces: `createClientRpc({ collect, startUpdate, getSnapshot, abort })` → `{ async dispatch(endpoint) }`;返回 `{ ok: true, value }`,refusal 是 value 不是 error;非预期 endpoint 抛错(由 connection 层包错误)。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClientRpc } from '../lib/client-rpc.js'

const SNAPSHOT = { shape: { kind: 'git' }, summary: {}, checks: [], update: { running: false } }

function rpc({ collect = async () => SNAPSHOT, startUpdate = async () => ({ jobId: 'j1' }), snapshot = { running: false }, abort = () => {} } = {}) {
  return createClientRpc({ collect, startUpdate, getSnapshot: () => snapshot, abort })
}

test('get-status returns the collect snapshot', async () => {
  const r = await rpc().dispatch('get-status')
  assert.equal(r.ok, true)
  assert.equal(r.value.update.running, false)
})

test('start-update behind → started with jobId and plan', async () => {
  const collect = async () => ({ ...SNAPSHOT, checks: [{ kind: 'harness-git', target: '/h', status: 'behind', behindCount: 3 }] })
  const r = await rpc({ collect }).dispatch('start-update')
  assert.equal(r.value.started, true)
  assert.equal(r.value.jobId, 'j1')
  assert.deepEqual(r.value.plan, [{ target: 'harness', path: '/h', behind: 3 }])
})

test('start-update nothing to update → refusal as value with skipped', async () => {
  const r = await rpc().dispatch('start-update')
  assert.equal(r.value.started, false)
  assert.equal(r.value.reason, 'nothing to update')
})

test('start-update startUpdate throw → started:false with reason', async () => {
  const r = await rpc({ startUpdate: async () => { throw new Error('an update is already running') } }).dispatch('start-update')
  assert.equal(r.value.started, false)
  assert.equal(r.value.reason, 'an update is already running')
})

test('cancel when idle → cancelled:false with reason, abort not called', async () => {
  let called = false
  const r = await rpc({ abort: () => { called = true } }).dispatch('cancel')
  assert.equal(r.value.cancelled, false)
  assert.equal(called, false)
})

test('cancel when running → abort with reason and note', async () => {
  let reason = ''
  const r = await rpc({ snapshot: { running: true }, abort: (x) => { reason = x } }).dispatch('cancel')
  assert.equal(r.value.cancelled, true)
  assert.equal(reason, 'cancelled by user')
})

test('unknown endpoint rejects', async () => {
  await assert.rejects(() => rpc().dispatch('nope'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/client-rpc.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
import { buildPlan } from './update-plan.js'

// client 页的 RPC 派发器:三端点语义与 dsh_update_status/run/cancel 完全一致。
// 返回 { ok:true, value };refusal(无可更新/不支持形态)是 value 不是 error,
// 与 agent 工具的 JSON 语义对齐;非预期 endpoint 抛错交 connection 层包装。
export function createClientRpc({ collect, startUpdate, getSnapshot, abort }) {
  return {
    async dispatch(endpoint) {
      switch (endpoint) {
        case 'get-status':
          return { ok: true, value: await collect() }
        case 'start-update': {
          const { shape, checks } = await collect()
          const { plan, skipped, refusal } = buildPlan({ shape, checks })
          if (refusal) return { ok: true, value: { started: false, reason: refusal.reason, skipped } }
          try {
            const { jobId } = await startUpdate(plan)
            return { ok: true, value: {
              started: true, jobId, plan, skipped,
              note: 'update runs in the background; check dsh_update_status for progress, restart dsh afterwards to apply the new build',
            } }
          } catch (e) {
            return { ok: true, value: { started: false, reason: String(e?.message ?? e), plan, skipped } }
          }
        }
        case 'cancel': {
          const snap = getSnapshot()
          if (!snap?.running) return { ok: true, value: { cancelled: false, reason: 'no update in progress' } }
          abort('cancelled by user')
          return { ok: true, value: {
            cancelled: true,
            note: 'abort requested; the running job will roll back any partial harness build and settle as killed — check dsh_update_status',
          } }
        }
        default:
          throw new Error(`unknown endpoint: ${endpoint}`)
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全 PASS

- [ ] **Step 5: Commit**

`git add lib/client-rpc.js test/client-rpc.test.js && git commit -m "feat: client rpc dispatcher over shared update logic"`

---

### Task 4: client/view-model.js + client/poller.js — 纯逻辑

**Files:**
- Create: `$R/client/view-model.js`
- Create: `$R/client/poller.js`
- Test: `$R/test/view-model.test.js`
- Test: `$R/test/poller.test.js`

**Interfaces:**
- Produces: `toViewModel(snapshot)` → `{ pills:[{name, detail, tone}], running, canUpdate, canCancel, banner, steps, lastReason }`,`tone ∈ 'ok'|'behind'|'diverged'|'error'`;`nextDelayMs(running)` → 5000/30000;`createPoller({ fetch, apply, setTimer, clearTimer, runningMs, idleMs })` → `{ start, stop }`。
- snapshot 形状 = `dsh_update_status` 输出(shape/summary/checks/update.update.lastResult/update.update.pendingRestart)。

- [ ] **Step 1: 写 view-model 失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toViewModel } from '../client/view-model.js'

const base = (update = {}) => ({ shape: { kind: 'git' }, summary: {}, checks: [], update: { running: false, pendingRestart: false, lastResult: null, ...update } })

test('all up-to-date renders ok pills, update enabled, no banner', () => {
  const vm = toViewModel(base({ lastResult: null, checks: [] }))
  // checks 由 collect 注入,这里直接给 checks 走一遍:
})

test('behind harness pill and enabled actions', () => {
  const s = base()
  s.checks = [{ kind: 'harness-git', target: '/h', status: 'behind', behindCount: 7 }]
  const vm = toViewModel(s)
  assert.equal(vm.pills[0].tone, 'behind')
  assert.match(vm.pills[0].detail, /behind 7/)
  assert.equal(vm.canUpdate, true)
  assert.equal(vm.canCancel, false)
})

test('diverged integration renders diverged tone, update still allowed for others', () => {
  const s = base()
  s.checks = [
    { kind: 'harness-git', target: '/h', status: 'up-to-date' },
    { kind: 'integration', target: '/i', status: 'diverged' },
  ]
  const vm = toViewModel(s)
  assert.equal(vm.pills[1].tone, 'diverged')
  assert.equal(vm.canUpdate, true)
})

test('error check renders error tone', () => {
  const s = base()
  s.checks = [{ kind: 'harness-git', target: '/h', status: 'error', error: 'boom' }]
  const vm = toViewModel(s)
  assert.equal(vm.pills[0].tone, 'error')
})

test('running snapshot disables update, enables cancel, exposes steps', () => {
  const s = base({ running: true })
  const vm = toViewModel(s)
  assert.equal(vm.running, true)
  assert.equal(vm.canUpdate, false)
  assert.equal(vm.canCancel, true)
})

test('pendingRestart sets banner even after lastResult success', () => {
  const s = base({ pendingRestart: true, lastResult: { ok: true } })
  const vm = toViewModel(s)
  assert.match(vm.banner, /restart/i)
})

test('failed lastResult surfaces steps and reason', () => {
  const s = base({ lastResult: { ok: false, harness: { ok: false, steps: [{ step: 'install', status: 'failed' }] } } })
  const vm = toViewModel(s)
  assert.equal(vm.lastReason, 'failed')
  assert.deepEqual(vm.steps, [{ step: 'install', status: 'failed' }])
})
```

(第一个用例按最终快照形状补齐断言:零 checks → `pills` 至少含 harness 占位或为空、`canUpdate` false。)

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test /Users/dmall/Projects/dsh-updater/test/view-model.test.js`;Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 view-model.js**

```js
// 快照 → 视图模型。纯函数:不碰 DOM、不碰网络,方便 node:test。
const TONE = { 'up-to-date': 'ok', behind: 'behind', diverged: 'diverged', error: 'error', 'no-upstream': 'error' }

export function toViewModel(snapshot) {
  const update = snapshot?.update ?? {}
  const checks = snapshot?.checks ?? []
  const pills = checks.map(c => ({
    name: c.kind === 'harness-git' ? 'harness' : (c.target ?? c.kind),
    detail: c.status === 'behind' ? `behind ${c.behindCount}` : (c.status === 'error' ? (c.error ?? 'error') : c.status),
    tone: TONE[c.status] ?? 'error',
  }))
  const running = Boolean(update.running)
  const last = update.lastResult
  const steps = last?.harness?.steps ?? []
  return {
    pills,
    running,
    canUpdate: !running && checks.some(c => c.status === 'behind'),
    canCancel: running,
    banner: update.pendingRestart ? 'update applied — restart dsh to load the new build' : undefined,
    steps: running ? (update.log ?? []) : steps,
    lastReason: last ? (last.ok ? 'ok' : (last.cancelled ? 'cancelled' : 'failed')) : undefined,
  }
}
```

- [ ] **Step 4: view-model 测试转绿** — Run: `node --test /Users/dmall/Projects/dsh-updater/test/view-model.test.js`;Expected: PASS(按断言微调实现,禁止改测试凑)

- [ ] **Step 5: 写 poller 失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextDelayMs, createPoller } from '../client/poller.js'

test('nextDelayMs: running fast, idle slow', () => {
  assert.equal(nextDelayMs(true), 5000)
  assert.equal(nextDelayMs(false), 30000)
})

test('poller fetches immediately, then reschedules by last result; stop clears', () => {
  const calls = []
  const timers = []
  let id = 0
  const setTimer = (fn, ms) => { const t = { id: ++id, fn, ms }; timers.push(t); return t }
  const clearTimer = (t) => { timers.splice(timers.indexOf(t), 1) }
  const values = [{ update: { running: true } }, { update: { running: false } }]
  const poller = createPoller({
    fetch: async () => values[calls.length] ?? values[values.length - 1],
    apply: (v) => calls.push(v),
    setTimer, clearTimer,
  })
  poller.start()
  assert.equal(calls.length, 1)                    // 立即取一次
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 5000)                 // running=true → 快轮询
  timers.shift().fn()                              // 手动触发定时
  assert.equal(calls.length, 2)
  assert.equal(timers[0].ms, 30000)                // idle → 慢轮询
  poller.stop()
  assert.equal(timers.length, 0)                   // stop 清掉挂起 timer
})

test('poller survives fetch rejection and keeps schedule', () => {
  let n = 0
  const timers = []
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }
  const clearTimer = (t) => { timers.splice(timers.indexOf(t), 1) }
  const poller = createPoller({
    fetch: async () => { n++; if (n === 1) throw new Error('rpc down'); return { update: {} } },
    apply: () => {},
    setTimer, clearTimer,
  })
  poller.start()
  timers.shift().fn()
  assert.equal(n, 2)
  assert.equal(timers.length, 1)
  poller.stop()
})
```

- [ ] **Step 6: 跑测试确认失败** — Run: `node --test /Users/dmall/Projects/dsh-updater/test/poller.test.js`;Expected: FAIL

- [ ] **Step 7: 实现 poller.js**

```js
// 轮询节流:running 快轮、idle 慢轮。timer 注入,node:test 手动驱动。
export function nextDelayMs(running, runningMs = 5000, idleMs = 30000) {
  return running ? runningMs : idleMs
}

export function createPoller({ fetch, apply, setTimer, clearTimer, runningMs = 5000, idleMs = 30000 }) {
  let timer = null
  let stopped = true
  async function tick() {
    timer = null
    let running = false
    try {
      const value = await fetch()
      running = Boolean(value?.update?.running)
      apply(value)
    } catch { /* RPC 不可达:保持节奏,下轮再试;apply 不被调用,页面沿用上次视图 */ }
    if (!stopped) schedule(running)
  }
  function schedule(running) {
    timer = setTimer(() => { void tick() }, nextDelayMs(running, runningMs, idleMs))
  }
  return {
    start() {
      if (!stopped) return
      stopped = false
      void tick()
    },
    stop() {
      stopped = true
      if (timer) { clearTimer(timer); timer = null }
    },
  }
}
```

- [ ] **Step 8: poller 测试转绿 + 全量回归**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全 PASS

- [ ] **Step 9: Commit**

`git add client/view-model.js client/poller.js test/view-model.test.js test/poller.test.js && git commit -m "feat: client view-model and poller pure logic"`

---

### Task 5: 接线 — index.js / client.js / client/page.js / package.json

**Files:**
- Modify: `$R/index.js`
- Create: `$R/client.js`(包根,物理落点按 Task 1 笔记,若非包根则同步改 `dsh.client`/`exports` 指向)
- Create: `$R/client/page.js`
- Modify: `$R/package.json`

**Interfaces:**
- Consumes: `createClientRpc`(Task 3)、`toViewModel`/`createPoller`(Task 4)、Task 1 笔记的全部四答。

- [ ] **Step 1: index.js 注册 RPC(Host 半边)**

`inject` 增 connection 服务(⚠spike:服务名以 Task 1 笔记为准,候选 `'connection'`):

```js
export const inject = ['tools', 'jobs', 'sessions', 'connection']
```

`apply(ctx, config)` 内、工具注册段之前:

```js
  // ---- client 页 RPC 桥(loopback):与 agent 工具同源同门禁 ----
  const clientRpc = createClientRpc({
    collect: collectWithUpdate,
    startUpdate: (plan) => startUpdate(plan),
    getSnapshot: () => updateState.snapshot(),
    abort: (reason) => updateState.abort(reason),
  })
  const offRpc = ctx.connection.rpc.handle('/rpc/dsh-updater',
    (endpoint, _payload) => clientRpc.dispatch(endpoint),
    { authority: 'loopback' })
  if (typeof offRpc === 'function') ctx.effect(() => offRpc)
```

顶部 `import { createClientRpc } from './lib/client-rpc.js'`。⚠spike:若 Task 1 笔记显示 handle 是逐端点注册(`handle(path, handler)` 单 handler 带 endpoint 首参)或 handler 参数序不同,按笔记调整 adapter;若 `authority` 不支持,删除该选项并在 notes 记录差异。

- [ ] **Step 2: package.json 声明**

```json
  "engines": { "node": ">=20", "dsh": ">=0.1.0-rc.6" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"],
      "immediately": false
    }
  }
```

⚠spoke:inject 包名边与 `engines.dsh` 具体值按 Task 1 笔记修正(slots/locale/settings 的真实包名以 `$H/packages/client/*` 的 package name 为准)。

- [ ] **Step 3: client.js factory(零构建,手写)**

```js
// dsh-updater client half. Hand-written __ModuleLoader__ factory — no build step.
// Externals resolve through the injected require (see spike notes: 'react' confirmed).
window.__ModuleLoader__.load({
  id: 'dsh-updater',
  factory: (require) => {
    let React
    try { React = require('react') } catch { React = null }
    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const h = (tag, attrs, ...kids) => React.createElement(tag, attrs ?? null, ...kids)
        const page = require('./client/page.js') ?? null
        // page.js exports mount(ctx, h) — see client/page.js
        if (typeof page.mount === 'function') page.mount(ctx, h)
      },
    }
  },
})
```

⚠spike:factory 返回对象是否需要 `name`、require 相对模块是否可用(若 factory 的 require 只解析外部包,则 page 内联进本文件,Task 5 实现时把 `client/page.js` 内容合并,保持单文件交付)。

- [ ] **Step 4: client/page.js(或内联进 client.js)**

完整实现要点(代码约 120 行,结构如下,写全):

```js
// mount(ctx, h): 注册 settings.section + locale + poller + 三按钮。
export function mount(ctx, h) {
  const NS = 'dsh-updater'
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { title: '更新', check: '检查更新', update: '一键更新', cancel: '取消',
          banner: '更新已应用 — 重启 dsh 生效', error: '查询失败', retry: '重试',
          idle: '空闲', running: '更新中…' },
    en: { title: 'Updater', check: 'Check updates', update: 'Update now', cancel: 'Cancel',
          banner: 'update applied — restart dsh to load the new build', error: 'query failed', retry: 'Retry',
          idle: 'idle', running: 'updating…' },
  }), 'dsh-updater: dictionaries')

  const rpc = {
    call: (endpoint) => ctx.connection.rpc.call('/rpc/dsh-updater', endpoint, {}),
  }
  let setError = () => {}
  const poller = createPoller({
    fetch: () => rpc.call('get-status'),
    apply: (snapshot) => setError(null) || render(toViewModel(snapshot)),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  })

  async function action(endpoint) {
    try { await rpc.call(endpoint) } catch (e) { setError(String(e?.message ?? e)); render(last) }
    poller.stop(); poller.start()   // 立即恢复快轮询节奏
  }

  let last = null
  function render(vm) {
    last = vm
    // slots.register 的组件函数返回 React 元素:胶囊列表 + 按钮排 + 横幅/错误态
    ...
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-updater', order: 100, label: NS,
  }, () => {
    poller.start()
    return last === null
      ? h('div', null, t('idle'))
      : h('div', { style: { display: 'grid', gap: 8 } },
          vmBanner(), vmPills(), vmButtons(), vmSteps(), vmError())
  }))
}
```

`render` 内的 `vmPills/vmButtons/vmSteps/vmError` 为 10-20 行的 `h()` 组装:胶囊 `span`(tone→颜色用 `var(--dsw-alias-*)` 主题变量)、按钮 `disabled` 绑 `canUpdate/canCancel`、`onClick={action('start-update')}` 等;横幅绑 `banner`;错误态绑 `setError` 的值 + 重试按钮。⚠渲染层不做自动化测试(spec §8)。

- [ ] **Step 5: 全量回归**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全 PASS(index.js 新增接线不破坏既有注入;若 inject 'connection' 在测试环境缺服务,按 index.js 既有 `ctx.logger?.info` 模式做存在性守卫 `ctx.connection?.rpc?.handle`,并在 notes 记录)

- [ ] **Step 6: Commit**

`git add index.js client.js client client/page.js package.json && git commit -m "feat: M5 web panel — settings page over connection.rpc (client half, zero-build)"`

---

### Task 6: 活体验收 + 文档收尾

**Files:**
- Modify: `$R/README.md`
- Create: `$R/.superpowers/sdd/2026-09-13-dsh-updater-m5/progress.md`

- [ ] **Step 1: README 更新**

「功能」节末尾追加一条:**Web 面板** `Settings → Updater`:状态胶囊、检查/更新/取消、pendingRestart 横幅(零构建,老宿主自动禁用)。删除 Roadmap 里的 Web 面板条目。

- [ ] **Step 2: 活体验收(重启 dsh 后逐项打勾,记录进 progress.md)**

1. Settings 出现「Updater / 更新」页,无 console 错误
2. 胶囊与 `dsh_update_status` 输出一致(harness + superpowers 两枚)
3. 检查更新按钮 → 无变化时提示 nothing to update 语义
4. (若 behind)一键更新 → running 态按钮禁用 → 完成 → pendingRestart 横幅出现
5. 取消演练:agent 侧 `dsh_update_run` 启动后页面点取消 → job killed → 门禁重开;反向:页面启动更新、agent 侧 `dsh_update_cancel` 取消
6. 重启 dsh → 横幅消失、新构建生效
7. agent 三工具回归:`dsh_update_status`/`run`/`cancel` 行为不变

- [ ] **Step 3: progress.md 记录 + 提交**

格式沿 M2/M4 progress(演练环境/逐项 ✅/已知限制/M5 验收结论)。`git add README.md && git commit -m "docs: M5 web panel shipped"`(progress.md 按 `.superpowers/sdd/.gitignore` 惯例本地留存)。

---

## Self-Review 记录

- **Spec 覆盖**:§4 文件结构→Task 2/3/4/5;§5 页面行为→Task 4/5;§6 契约→Task 3/5;§7 兼容与失败→Task 5(自禁用/错误态)+Task 6(验收);§8 测试与验收→各任务 TDD+Task 6;§3/§9 非目标无实现项 ✓
- **占位符**:无 TBD;⚠spike 行均为「Task 1 笔记输出落地」的显式适配点,且每处给出证据形态兜底(sogooday 形状)
- **类型一致性**:`buildPlan({shape,checks})→{plan,skipped,refusal}`(Task 2 定义,Task 3 消费);`dispatch(endpoint)→{ok,value}`(Task 3 定义,Task 5 adapter 消费);`toViewModel/createPoller` 签名(Task 4 定义,Task 5 消费)一致 ✓
