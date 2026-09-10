# dsh-updater M4 实现计划(dsh_update_cancel 工具 + autoApply/idle 自动模式)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M4:注册 `dsh_update_cancel` agent 工具取消进行中的更新;在 `autoApply:true` 时,定时检查发现 behind 且系统 idle(无运行 job + 会话静默 ≥ idleQuietMs)则自动触发 M2 的更新 pipeline,失败版本不重试,更新后只提示重启不代重启。

**Architecture:** 延续 M1/M2 的「纯逻辑可注入 + I/O 分离」模式。三个新纯逻辑模块——`cancel-tool.js`(取消工具)、`idle.js`(idle 追踪器,注入时钟/jobs 列表)、`auto-apply.js`(自动应用决策器,注入 collectStatus/isIdle/startUpdate)——都不直接碰 harness 运行时,全部经依赖注入做单测。`index.js` 把它们接到真实的 `ctx.jobs.list`、`ctx.on('session/event')` 与既有的 `updateState`/`startUpdate` 上。Web 面板不在本计划(拆到 M5)。

**Tech Stack:** Node >= 20 ESM、`node:test`(零测试依赖)、依赖注入的假时钟/假 jobs 列表/假 pipeline 做单测;零第三方依赖,无 build 步骤。

**Spec:** `/Users/dmall/Projects/dsh-updater/docs/superpowers/specs/2026-09-09-dsh-updater-plugin-design.md`(§4 触发与安全/自动模式、§5 `dsh_update_cancel`、§8 里程碑 4)

> **设计定案注记(2026-09-10,brainstorming 对齐)**:①M4 只做 cancel + 自动模式,Web 面板拆为独立 M5(spec §8 里程碑 4 相应拆分);②idle 双条件均可干净实现——「无运行 job」用 `ctx.jobs.list()`,「会话静默」用 `ctx.on('session/event')` 时间戳(spike 已证实该事件为 `@mode emit`、post-commit、fire-and-forget,旁路观察安全);③自动模式四条边界:diverged/dirty 只报告不动、应用后只置 pending-restart 提示不代重启、同 behind 版本失败后不重试(除非上游再进出现新 remoteRef)、integrations 照常逐仓 ff-only。

## Global Constraints

- 仓位置:`/Users/dmall/Projects/dsh-updater`(下文以 `$R` 指代;bash 步骤一律绝对路径,不 `cd`)。
- 纯 JS ESM(`.js`,`"type": "module"`),零第三方依赖,无 build 步骤。
- 所有外部命令沿用 M2 的 `execFile`(数组参数)+ 超时,禁止 shell 拼接;M4 不新增外部命令,只复用 M2 的 pipeline。
- **自动应用仍受 spec §4 全部安全约束**:`pull` 仅 `--ff-only`;diverged/dirty 直接拒绝不动;install/build 失败 → `git reset --hard <pull 前 sha>` 回滚——这些由 M2 的 `runHarnessUpdate`/`updateGitRepo` 已实现,M4 不重写,只在 idle 时调用。
- **自动应用绝不代重启**:更新完成后只在 `updateState` 记 `pendingRestart:true` 并经 `dsh_update_status` 透出提示(spec §5「不代重启」;macOS 无 systemd)。
- **同版本失败不重试**:一个 `behind` 目标自动应用后若整体未成功,记录其 `remoteRef` 到 `attemptedVersions`;后续轮次该目标 `remoteRef` 不变则跳过,直到上游再进(`remoteRef` 变化)才再试(spec §6「连续失败不刷屏」)。
- **确认门仍是默认**:`autoApply:false`(patch 行默认值)时 M4 自动模式完全不启用,行为与 M2 一致;`dsh_update_cancel` 两种模式下都注册可用。
- 取消复用 M2:`updateState.abort(reason)` + job `run()` 返回的 `cancel` hook + install/build 期尽力回滚——M4 不写新回滚逻辑。
- config 不新增字段:`autoApply` 与 `idleQuietMs` 均为 M1 已在 `cordis.patch.yml` 预留的字段;`cordis.patch.yml` 不改。
- 测试命令统一:`node --test --test-reporter=spec "$R"/test/*.test.js`(显式 glob;目录位置参数在 Node ≥22 有回归)。

## File Structure

- `$R/lib/cancel-tool.js`(新)——`createCancelTool({ getSnapshot, abort })`,产出 `dsh_update_cancel` 工具定义。单一职责:取消门禁 + 工具契约。
- `$R/lib/idle.js`(新)——`createIdleTracker({ now, jobsList, idleQuietMs })`,产出 `{ touch, isIdle }`。单一职责:合成 idle 布尔。
- `$R/lib/auto-apply.js`(新)——`createAutoApplier({ collectStatus, isIdle, startUpdate, getAttempted, markAttempted })`,产出 `maybeAutoApply()`。单一职责:自动应用决策(什么该更、idle 否、是否已试过)。
- `$R/lib/update-state.js`(改)——`finish` 之外新增 `pendingRestart` 记录与 `snapshot` 透出;`attemptedVersions` 由 `auto-apply` 侧的闭包持有,不进 update-state(update-state 只管单次运行,跨轮记忆归 index.js 的模块级 Map)。
- `$R/index.js`(改)——`inject` 增 `'sessions'`;注册 cancel 工具;`autoApply` 为真时挂 `session/event` 监听并在既有定时检查回调后接 `maybeAutoApply()`;`pendingRestart` 透出。
- 对应测试文件:`$R/test/cancel-tool.test.js`、`$R/test/idle.test.js`、`$R/test/auto-apply.test.js`、`$R/test/update-state.test.js`(新增 pendingRestart 用例)。

---

### Task 1: lib/cancel-tool.js — dsh_update_cancel 门禁工具

**Files:**
- Create: `$R/lib/cancel-tool.js`
- Test: `$R/test/cancel-tool.test.js`

**Interfaces:**
- Consumes: 注入 `{ getSnapshot, abort }`——`getSnapshot(): { running, log, lastResult }`(即 M2 `updateState.snapshot`);`abort(reason: string): void`(即 M2 `updateState.abort`)。
- Produces: `createCancelTool({ getSnapshot, abort }): ToolDefinition`。工具 `dsh_update_cancel`,输入 schema `{ type:'object', properties:{} }`;`output: { schema:{type:'string'}, render }`;`execute(args, exec)` 返回 JSON 字符串:
  - 无运行更新 → `{ cancelled:false, reason:'no update in progress' }`
  - 有运行更新 → 调 `abort('cancelled by user')` → `{ cancelled:true, note:'abort requested; the running job will roll back any partial harness build and settle as killed — check dsh_update_status' }`

- [ ] **Step 1: 写失败测试**

`$R/test/cancel-tool.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCancelTool } from '../lib/cancel-tool.js'

test('no running update → cancelled:false with reason, abort not called', async () => {
  let aborted = false
  const tool = createCancelTool({
    getSnapshot: () => ({ running: false, log: [], lastResult: null }),
    abort: () => { aborted = true },
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.cancelled, false)
  assert.match(out.reason, /no update in progress/)
  assert.equal(aborted, false)
})

test('running update → abort called with reason, cancelled:true', async () => {
  const calls = []
  const tool = createCancelTool({
    getSnapshot: () => ({ running: true, log: [], lastResult: null }),
    abort: (r) => calls.push(r),
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.cancelled, true)
  assert.deepEqual(calls, ['cancelled by user'])
  assert.match(out.note, /roll back/i)
})

test('tool shape: name, output.schema, render present', () => {
  const tool = createCancelTool({ getSnapshot: () => ({ running: false }), abort: () => {} })
  assert.equal(tool.name, 'dsh_update_cancel')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/cancel-tool.test.js`
Expected: FAIL(`Cannot find module .../lib/cancel-tool.js`)

- [ ] **Step 3: 实现 `$R/lib/cancel-tool.js`**

```js
export function createCancelTool({ getSnapshot, abort }) {
  return {
    name: 'dsh_update_cancel',
    description: 'Cancel the update currently running in the background. Aborts the running job; any partial harness build is rolled back and the job settles as killed. Reports "no update in progress" when nothing is running.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args, _exec) {
      const snap = getSnapshot()
      if (!snap?.running) {
        return JSON.stringify({ cancelled: false, reason: 'no update in progress' }, null, 2)
      }
      abort('cancelled by user')
      return JSON.stringify({
        cancelled: true,
        note: 'abort requested; the running job will roll back any partial harness build and settle as killed — check dsh_update_status',
      }, null, 2)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/cancel-tool.test.js`
Expected: 3 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/cancel-tool.js test/cancel-tool.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: dsh_update_cancel tool gating on running-update state"
```

---

### Task 2: lib/idle.js — idle 追踪器(无运行 job + 会话静默)

**Files:**
- Create: `$R/lib/idle.js`
- Test: `$R/test/idle.test.js`

**Interfaces:**
- Consumes: 注入 `{ now, jobsList, idleQuietMs }`——`now(): number`(默认 `Date.now`);`jobsList(): { status: string }[]`(即 M2 装配可用的 `ctx.jobs.list()` 结果,只读取 `status`);`idleQuietMs: number`。
- Produces: `createIdleTracker({ now, jobsList, idleQuietMs }): { touch(): void, isIdle(): boolean }`。
  - `touch()` 把 `lastActivityAt` 置为 `now()`。构造时 `lastActivityAt` 初始化为 `now()`(避免启动瞬间即判 idle)。
  - `isIdle()` 为真 ⟺ `jobsList()` 中无 `status` 为 `'running'` 或 `'stopping'` 的项 **且** `now() - lastActivityAt >= idleQuietMs`。
  - `jobsList` 抛错时按「非 idle」处理(保守:探测不到 job 状态就不自动应用),不抛出。

- [ ] **Step 1: 写失败测试**

`$R/test/idle.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdleTracker } from '../lib/idle.js'

// 可控时钟
function clock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('idle when no running job and quiet long enough', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [{ status: 'completed' }], idleQuietMs: 2000 })
  c.advance(2000)
  assert.equal(tr.isIdle(), true)
})

test('not idle while a job is running', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [{ status: 'running' }], idleQuietMs: 2000 })
  c.advance(5000)
  assert.equal(tr.isIdle(), false)
})

test('not idle while a job is stopping', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [{ status: 'stopping' }], idleQuietMs: 2000 })
  c.advance(5000)
  assert.equal(tr.isIdle(), false)
})

test('not idle before quiet threshold elapses', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [], idleQuietMs: 2000 })
  c.advance(1999)
  assert.equal(tr.isIdle(), false)
})

test('touch resets the quiet timer', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [], idleQuietMs: 2000 })
  c.advance(1500)
  tr.touch()          // 活动:重置
  c.advance(1500)     // 距上次活动仅 1500 < 2000
  assert.equal(tr.isIdle(), false)
  c.advance(500)      // 现在距上次 touch 2000
  assert.equal(tr.isIdle(), true)
})

test('jobsList throwing → treated as not idle, never throws', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => { throw new Error('no jobs service') }, idleQuietMs: 2000 })
  c.advance(5000)
  assert.equal(tr.isIdle(), false)
})

test('starts non-idle at construction (no immediate auto-apply)', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [], idleQuietMs: 2000 })
  assert.equal(tr.isIdle(), false) // 距构造 0ms < 2000
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/idle.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/idle.js`**

```js
export function createIdleTracker({ now = () => Date.now(), jobsList, idleQuietMs }) {
  let lastActivityAt = now()
  const anyBusy = () => {
    let jobs
    try { jobs = jobsList() } catch { return true } // 探测不到 job 状态:保守当作忙
    return (jobs ?? []).some(j => j?.status === 'running' || j?.status === 'stopping')
  }
  return {
    touch() { lastActivityAt = now() },
    isIdle() {
      if (anyBusy()) return false
      return now() - lastActivityAt >= idleQuietMs
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/idle.test.js`
Expected: 7 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/idle.js test/idle.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: idle tracker over job status and session-activity quiet window"
```

---

### Task 3: lib/auto-apply.js — 自动应用决策器

**Files:**
- Create: `$R/lib/auto-apply.js`
- Test: `$R/test/auto-apply.test.js`

**Interfaces:**
- Consumes:
  - `collectStatus(): Promise<{ shape, checks }>`——即 M1 `collectStatus` 的 `{ shape:{kind,...}, checks: CheckResult[] }`;CheckResult 字段沿用 M1/M2:`{ target, kind:'harness-git'|'integration', status, behindCount, remoteRef, ... }`。
  - `isIdle(): boolean`——即 Task 2 `tracker.isIdle`。
  - `startUpdate(plan): Promise<{ jobId }>`——即 M2 index.js 注入的 `startUpdate`(注意:M4 的 auto 路径**不传 exec**,故 startUpdate 第二参可空;M2 实现里 `exec?.agent` 已容 undefined)。**plan 形状必须与 M2 `dsh_update_run` 构造的一致**:harness 项 `{ target:'harness', path, behind }`,integration 项 `{ target:<repoPath>, behind }`。
  - `getAttempted(): Map<string,string>`、`markAttempted(target: string, remoteRef: string): void`——跨轮记忆「某 target 在某 remoteRef 上已尝试过」;key 用 `check.target`,value 用 `check.remoteRef`。由 index.js 持有的模块级 Map 提供。
- Produces: `createAutoApplier(deps): { maybeAutoApply(): Promise<{ started, reason?, jobId?, plan? }> }`。
  - 判定顺序:`collectStatus()` → `shape.kind !== 'git'` → `{ started:false, reason:'shape not git' }`;收集 `behind` 且未在 attempted(同 remoteRef)里的目标构造 plan;plan 为空 → `{ started:false, reason:'nothing new to auto-apply' }`;`!isIdle()` → `{ started:false, reason:'not idle' }`;否则对 plan 中每个目标 `markAttempted(target, remoteRef)`(**先标记再启动**——避免下一轮定时器在本轮 job 未结束时重复触发同版本),再 `startUpdate(plan)` → `{ started:true, jobId, plan }`;`startUpdate` 抛错(如 already running)→ `{ started:false, reason:<message> }`。
  - diverged / dirty / error / no-upstream / up-to-date 目标一律不入 plan(只有 `behind` 入)——满足「diverged/dirty 只报告不动」。

- [ ] **Step 1: 写失败测试**

`$R/test/auto-apply.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutoApplier } from '../lib/auto-apply.js'

const GIT = { kind: 'git', harnessRoot: '/harness' }

function harnessCheck(status, remoteRef = 'r1', behindCount = status === 'behind' ? 3 : 0) {
  return { target: '/harness', kind: 'harness-git', status, behindCount, remoteRef }
}
function intCheck(name, status, remoteRef = 'i1') {
  return { target: `/ints/${name}`, kind: 'integration', status, behindCount: status === 'behind' ? 1 : 0, remoteRef }
}
// 简易 attempted 存储
function attemptedStore(init = []) {
  const m = new Map(init)
  return { getAttempted: () => m, markAttempted: (t, r) => m.set(t, r), _m: m }
}

test('behind harness + idle → starts update, plan matches M2 shape, marked before start', async () => {
  const store = attemptedStore()
  let markedBeforeStart = false
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind', 'rNEW')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted,
    markAttempted: store.markAttempted,
    startUpdate: async () => { markedBeforeStart = store._m.get('/harness') === 'rNEW'; return { jobId: 'dsh-update-9' } },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, true)
  assert.equal(r.jobId, 'dsh-update-9')
  assert.deepEqual(r.plan, [{ target: 'harness', path: '/harness', behind: 3 }])
  assert.equal(markedBeforeStart, true)
})

test('behind but not idle → does not start', async () => {
  let started = false
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind')] }),
    isIdle: () => false,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { started = true; return { jobId: 'x' } },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /not idle/)
  assert.equal(started, false)
})

test('non-git shape → refused', async () => {
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: { kind: 'unknown' }, checks: [] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => ({ jobId: 'x' }),
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /not git/)
})

test('diverged harness is never planned', async () => {
  const store = attemptedStore()
  let started = false
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('diverged')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { started = true; return { jobId: 'x' } },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /nothing new/)
  assert.equal(started, false)
})

test('already-attempted same remoteRef is skipped; new remoteRef retries', async () => {
  const store = attemptedStore([['/harness', 'rOLD']])
  let starts = 0
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind', 'rOLD')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { starts++; return { jobId: 'x' } },
  })
  const r1 = await applier.maybeAutoApply()
  assert.equal(r1.started, false)          // 同 remoteRef 已试过 → 跳过
  assert.match(r1.reason, /nothing new/)

  // 上游再进:remoteRef 变化 → 应重试
  const applier2 = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind', 'rNEWER')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { starts++; return { jobId: 'x' } },
  })
  const r2 = await applier2.maybeAutoApply()
  assert.equal(r2.started, true)
  assert.equal(starts, 1)
})

test('mixed: behind harness + behind int + up-to-date int + diverged int → plan has only the two behind', async () => {
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [
      harnessCheck('behind', 'rH'),
      intCheck('sp', 'behind', 'rSP'),
      intCheck('up', 'up-to-date'),
      intCheck('dv', 'diverged'),
    ] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async (plan) => ({ jobId: 'x', _plan: plan }),
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, true)
  assert.deepEqual(r.plan, [
    { target: 'harness', path: '/harness', behind: 3 },
    { target: '/ints/sp', behind: 1 },
  ])
})

test('startUpdate throwing (already running) → started:false with reason', async () => {
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { throw new Error('an update is already running') },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /already running/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/auto-apply.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/auto-apply.js`**

```js
export function createAutoApplier({ collectStatus, isIdle, startUpdate, getAttempted, markAttempted }) {
  return {
    async maybeAutoApply() {
      const { shape, checks } = await collectStatus()
      if (shape?.kind !== 'git') return { started: false, reason: 'shape not git' }
      const attempted = getAttempted()
      const plan = []
      for (const c of checks) {
        if (c.status !== 'behind') continue                 // diverged/dirty/error/up-to-date 不动
        if (attempted.get(c.target) === c.remoteRef) continue // 同 remoteRef 已试过,不重试
        if (c.kind === 'harness-git') plan.push({ target: 'harness', path: c.target, behind: c.behindCount })
        else if (c.kind === 'integration') plan.push({ target: c.target, behind: c.behindCount })
      }
      if (plan.length === 0) return { started: false, reason: 'nothing new to auto-apply' }
      if (!isIdle()) return { started: false, reason: 'not idle' }
      // 先标记再启动:避免下一轮定时器在本轮 job 未结束时重复触发同版本
      for (const c of checks) {
        if (c.status === 'behind') markAttempted(c.target, c.remoteRef)
      }
      try {
        const { jobId } = await startUpdate(plan)
        return { started: true, jobId, plan }
      } catch (e) {
        return { started: false, reason: String(e?.message ?? e), plan }
      }
    },
  }
}
```

(注:标记循环遍历所有 `behind` check——即使某目标因 attempted 被排除出 plan,重标同 remoteRef 是幂等的;这样保证 plan 内目标一定被标记。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/auto-apply.test.js`
Expected: 7 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/auto-apply.js test/auto-apply.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: auto-apply decision (behind + idle + no-retry-same-version)"
```

---

### Task 4: lib/update-state.js — pendingRestart 记录与透出

**Files:**
- Modify: `$R/lib/update-state.js`
- Test: `$R/test/update-state.test.js`(新建;M2 未单独测 update-state,借 M4 补上并覆盖新字段)

**Interfaces:**
- Consumes: 无(独立)。
- Produces: `createUpdateState()` 在原有方法基础上:
  - `finish(summary)` 保持原语义;当 `summary.ok === true` 且本次实际推进过(`summary.harness?.toSha !== summary.harness?.fromSha` 或 integrations 有 `updated`)时,置内部 `pendingRestart = true`。为避免把「推进判定」逻辑塞进 update-state(它不该懂 summary 结构),改为**显式方法** `notePendingRestart(): void` 由 pipeline/index 调用;`finish` 不再推断。
  - `snapshot()` 额外返回 `pendingRestart: boolean`。
  - `clearPendingRestart(): void`——预留给 M5 面板/未来重启后清位,本计划不调用但实现并测试(接口稳定)。

  最终 update-state 对外形状:`{ begin, abort, signal, stage, finish, snapshot, notePendingRestart, clearPendingRestart }`;`snapshot()` → `{ running, log, lastResult, pendingRestart }`。

- [ ] **Step 1: 写失败测试**

`$R/test/update-state.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateState } from '../lib/update-state.js'

test('snapshot exposes pendingRestart:false initially', () => {
  const s = createUpdateState()
  assert.equal(s.snapshot().pendingRestart, false)
})

test('notePendingRestart flips the flag; clearPendingRestart resets it', () => {
  const s = createUpdateState()
  s.notePendingRestart()
  assert.equal(s.snapshot().pendingRestart, true)
  s.clearPendingRestart()
  assert.equal(s.snapshot().pendingRestart, false)
})

test('begin does not clear a standing pendingRestart (restart is cross-run)', () => {
  const s = createUpdateState()
  s.notePendingRestart()
  assert.equal(s.begin(), true)
  assert.equal(s.snapshot().pendingRestart, true) // 未重启前一直提示
})

// M2 既有语义回归(补测,防 M4 改动回退)
test('begin/finish gate still works', () => {
  const s = createUpdateState()
  assert.equal(s.begin(), true)
  assert.equal(s.begin(), false)
  s.finish({ ok: true })
  assert.equal(s.begin(), true)
  assert.ok(s.snapshot().lastResult.finishedAt > 0)
})

test('abort before begin is a no-op (no controller yet)', () => {
  const s = createUpdateState()
  assert.doesNotThrow(() => s.abort('x'))
  assert.equal(s.signal, undefined)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/update-state.test.js`
Expected: FAIL(`notePendingRestart is not a function` / `pendingRestart` undefined)

- [ ] **Step 3: 修改 `$R/lib/update-state.js`**

在 `createUpdateState` 内新增 `let pendingRestart = false`,并在返回对象中新增/修改:

```js
export function createUpdateState() {
  let running = false
  let controller = null
  let log = []
  let lastResult = null
  let pendingRestart = false
  return {
    begin() {
      if (running) return false
      running = true
      controller = new AbortController()
      log = []
      lastResult = null
      return true
    },
    abort(reason) {
      controller?.abort(new Error(reason ?? 'update cancelled'))
    },
    get signal() {
      return controller?.signal
    },
    stage(entry) {
      log.push({ at: Date.now(), ...entry })
    },
    finish(summary) {
      running = false
      lastResult = { finishedAt: Date.now(), ...summary }
    },
    notePendingRestart() {
      pendingRestart = true
    },
    clearPendingRestart() {
      pendingRestart = false
    },
    snapshot() {
      return { running, log: [...log], lastResult, pendingRestart }
    },
  }
}
```

(`begin` 刻意不重置 `pendingRestart`——重启是跨运行的挂起提示,直到用户真正重启 dsh 才由 `clearPendingRestart` 清除;本计划不接自动清除,提示会一直显示到进程重启,进程重启后状态本就重置。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/update-state.test.js`
Expected: 5 个 PASS

- [ ] **Step 5: 全量回归(确认 M2 的 update-run 用例不受影响)**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 此前全部 PASS + 新增用例 PASS(update-run 的 snapshot 断言若曾 deepEqual 整个 snapshot 需确认——M2 用例只读 `.running`/`.log`/`.lastResult`,新增字段不破坏)

- [ ] **Step 6: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/update-state.js test/update-state.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: pendingRestart flag on update-state, exposed via snapshot"
```

---

### Task 5: index.js 装配(cancel 工具 + session/event 监听 + 自动应用) + 真机验收

**Files:**
- Modify: `$R/index.js`(整体替换)
- Modify: `$R/README.md`(M4 行为段:cancel 工具、autoApply/idle、不代重启)
- Modify: `$R/docs/superpowers/specs/2026-09-09-dsh-updater-plugin-design.md`(§4/§5/§8 状态同步)

**Interfaces:**
- Consumes: Task 1 `createCancelTool`、Task 2 `createIdleTracker`、Task 3 `createAutoApplier`、Task 4 update-state 新方法;M2 既有 `createStatusTool`/`createRunTool`/`startUpdate`/`runUpdatePipeline`/`collectStatus`。
- Produces: 装配变更——
  - `inject = ['tools', 'jobs', 'sessions']`(增 `'sessions'` 以监听 `session/event`)。
  - 模块级(apply 闭包内)`const attemptedVersions = new Map()`——跨定时轮次记忆(Task 3 的 `getAttempted`/`markAttempted` 由它支撑)。
  - idle tracker:`createIdleTracker({ jobsList: () => ctx.jobs.list(), idleQuietMs: cfg.idleQuietMs })`;`ctx.on('session/event', () => idle.touch())`(disposer 交 cordis fiber 作用域自动清理,与 M2 的工具注册一致;若返回 disposer 则并入 `ctx.effect`)。
  - `pendingRestart` 透出:`collectWithUpdate` 已把 `updateState.snapshot()` 挂到 `update` 字段——snapshot 现含 `pendingRestart`,自动透出,无需改 tool.js。
  - job 成功后置 pendingRestart:在 `startUpdate` 的 `run().done` 成功分支(`summary.ok && !summary.cancelled`)调 `updateState.notePendingRestart()`。
  - 注册 `createCancelTool({ getSnapshot: () => updateState.snapshot(), abort: (r) => updateState.abort(r) })`。
  - 自动应用挂载:`autoApply` 为真时,在既有 `runStatus` 定时回调**之后**追加 `void autoApplier.maybeAutoApply().catch(...)`;`autoApply` 为假时完全不构造 autoApplier、不挂 `session/event`(零开销、行为同 M2)。
  - `maybeAutoApply` 的 startUpdate 注入:复用同一个 `startUpdate`(不传 exec → job owner 为 undefined,M2 已容);auto 与手动共用一把 `updateState.begin()` 互斥锁,自动应用撞上手动运行会得到 `already running` 并跳过。

- [ ] **Step 1: 整体替换 `$R/index.js`**

```js
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatus } from './lib/status.js'
import { createStatusTool } from './lib/tool.js'
import { createRunTool } from './lib/run-tool.js'
import { createCancelTool } from './lib/cancel-tool.js'
import { createUpdateState } from './lib/update-state.js'
import { runUpdatePipeline } from './lib/update-run.js'
import { createIdleTracker } from './lib/idle.js'
import { createAutoApplier } from './lib/auto-apply.js'

export const name = 'dsh-updater'
// 工具注册要等 tools;jobs.start / jobs.list 要等 jobs;session/event 要等 sessions
export const inject = ['tools', 'jobs', 'sessions']

const DEFAULTS = {
  checkOnStart: true,
  checkIntervalMinutes: 30,
  autoApply: false,
  idleQuietMs: 120000,
  npmDistTag: 'latest',
  integrationsDir: '~/.dsh/integrations',
}

function dshBinPath() {
  // spec §2:从运行中 dsh 的 bin 路径回溯 harness 根 / npm 包。
  try { return realpathSync(process.argv[1]) } catch { return fileURLToPath(import.meta.url) }
}

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config }
  const binPath = dshBinPath()
  const updateState = createUpdateState()
  const attemptedVersions = new Map()
  ctx.logger?.info?.('dsh-updater loaded, checkOnStart=%s autoApply=%s', cfg.checkOnStart, cfg.autoApply)

  const collect = (opts = {}) => collectStatus({ ...opts, config: cfg, env: { binPath } })
  const collectWithUpdate = async (opts = {}) => ({ ...await collect(opts), update: updateState.snapshot() })

  // ---- startUpdate:手动与自动共用(begin() 互斥锁) ----
  const startUpdate = (plan, exec) => {
    if (!updateState.begin()) throw new Error('an update is already running')
    const harnessPath = plan.find(t => t.target === 'harness')?.path ?? null
    let jobId
    try {
      jobId = ctx.jobs.start({
        kind: 'dsh-update',
        label: `dsh-updater: update ${plan.length} target(s)`,
        owner: exec?.agent,
        run() {
          const done = runUpdatePipeline({
            updateState,
            harnessPath,
            integrationsRoot: expandHome(cfg.integrationsDir),
            gitBin: 'git',
            pnpmBin: 'pnpm',
          }).then(summary => {
            if (summary.ok && !summary.cancelled) updateState.notePendingRestart()
            return {
              status: summary.cancelled ? 'killed' : summary.ok ? 'completed' : 'failed',
              detail: summary.cancelled ? 'cancelled' : summary.ok ? 'update finished' : 'update finished with failures; run dsh_update_status for steps',
              output: JSON.stringify(summary, null, 2),
            }
          }, (e) => ({
            status: 'failed',
            detail: String(e?.message ?? e),
          }))
          return {
            cancel: () => updateState.abort('cancelled by user'),
            done,
          }
        },
      })
    } catch (e) {
      updateState.finish({ ok: false, cancelled: false, harness: null, integrations: [] })
      throw e
    }
    return { jobId }
  }

  // ---- idle 追踪 + 自动应用(仅 autoApply:true) ----
  let autoApplier = null
  if (cfg.autoApply) {
    const idle = createIdleTracker({
      jobsList: () => ctx.jobs.list(),
      idleQuietMs: Number.isFinite(cfg.idleQuietMs) && cfg.idleQuietMs >= 0 ? cfg.idleQuietMs : 120000,
    })
    const off = ctx.on('session/event', () => idle.touch())
    if (typeof off === 'function') ctx.effect(() => off)
    autoApplier = createAutoApplier({
      collectStatus: collect,
      isIdle: () => idle.isIdle(),
      startUpdate: (plan) => startUpdate(plan),
      getAttempted: () => attemptedVersions,
      markAttempted: (t, r) => attemptedVersions.set(t, r),
    })
  }

  // ---- 定时检查(+ 自动应用) ----
  const runStatus = () => collect()
    .then(({ shape, checks }) => {
      const problems = checks.filter(c => c.status === 'behind' || c.status === 'diverged' || c.status === 'error')
      if (problems.length) ctx.logger?.info?.('dsh-updater: %d update-relevant results (shape=%s)', problems.length, shape.kind)
    })
    .catch(e => ctx.logger?.warn?.('dsh-updater check failed: %s', e?.message ?? e))
    .then(() => {
      if (autoApplier) {
        return autoApplier.maybeAutoApply()
          .then(r => { if (r.started) ctx.logger?.info?.('dsh-updater: auto-apply started job %s (%d target(s))', r.jobId, r.plan.length) })
          .catch(e => ctx.logger?.warn?.('dsh-updater auto-apply failed: %s', e?.message ?? e))
      }
    })

  if (cfg.checkOnStart) void runStatus()

  const minutes = Number.isFinite(cfg.checkIntervalMinutes) && cfg.checkIntervalMinutes >= 1 ? cfg.checkIntervalMinutes : 30
  const timer = setInterval(() => void runStatus(), minutes * 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  // ---- 工具注册 ----
  ctx.tools.register(createStatusTool({ collectStatus: collectWithUpdate }))
  ctx.tools.register(createRunTool({ collectStatus: collect, startUpdate }))
  ctx.tools.register(createCancelTool({
    getSnapshot: () => updateState.snapshot(),
    abort: (r) => updateState.abort(r),
  }))
}
```

(实现者注意:`ctx.on` 的返回值在本 harness 是否为 disposer 需按运行时确认——若返回 disposer 则如上并入 `ctx.effect`;若不返回则该行 `if` 自然跳过。两种皆安全。)

- [ ] **Step 2: README.md 追加 M4 行为段**

在现有 M2 段后追加一段(3-5 句):M4 起提供 `dsh_update_cancel` 工具随时取消进行中的更新(触发回滚,job 结算为 killed);开启 `autoApply:true` 后,定时检查发现新版且系统 idle(无运行 job 且会话静默 ≥ `idleQuietMs`)时自动执行更新,diverged/dirty 仍只报告不动、同版本失败不重试;自动更新完成后仅在 `dsh_update_status` 的 `update.pendingRestart` 提示重启,绝不代重启。

- [ ] **Step 3: spec 状态同步**

- §4 自动模式:措辞从「显式 opt-in(计划)」更新为「M4 已实现:idle = 无运行 job(`ctx.jobs.list`)且会话静默 ≥ idleQuietMs(`session/event` 时间戳)」。
- §5 工具表:`dsh_update_cancel` 行从隐含未实现更新为「M4 交付」;补一句 Web 面板拆至 M5。
- §8 里程碑:里程碑 4 拆为「M4:自动模式 + `dsh_update_cancel`」与新增「M5:Web 面板」。

- [ ] **Step 4: 全量测试**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全部 PASS(M1+M2 的 56 + M4 新增:cancel 3 + idle 7 + auto-apply 7 + update-state 5 = 22,合计 78)

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add index.js README.md docs/superpowers/specs/2026-09-09-dsh-updater-plugin-design.md
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: wire dsh_update_cancel and autoApply/idle auto-mode in index"
```

- [ ] **Step 6: 真机验收(命令侧 + 活体)**

```bash
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh plugin --profile web add /Users/dmall/Projects/dsh-updater
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh --profile web --dump-config 2>/dev/null | grep -c "dsh-updater"
```

Expected: add 幂等成功;grep ≥ 1。然后由用户重启 web profile,验收序列:

1. 新会话调 `dsh_update_status`:输出的 `update` 字段含 `pendingRestart:false`。
2. **cancel 空跑**:无更新进行时调 `dsh_update_cancel` → `{cancelled:false, reason:'no update in progress'}`。
3. **cancel 活体**(需用户同意真实更新):harness behind 时先 `dsh_update_run` 起 job,更新中调 `dsh_update_cancel` → `{cancelled:true}`;`dsh_update_status` 的 `update.log` 见 rollback、job 结算 killed、HEAD 回原位。
4. **autoApply**(可选,需用户显式改配置):把 patch 行 `autoApply` 改 `true`、`idleQuietMs` 调小(如 5000)重启后,harness behind 且会话静默过阈值时,定时轮次自动起 job;`dsh_update_status` 见推进,完成后 `pendingRestart:true`;同版本再跑不重复触发(attemptedVersions 生效)。
5. 提示用户:自动应用完成后仍需手动重启 dsh 应用新构建。

---

## Self-Review 记录

- **Spec 覆盖**:§4 确认门默认(`autoApply:false` 不启用)→ Task 5;§4 自动模式 opt-in + idle 双条件(无 job + 静默)→ Task 2(idle 合成)+ Task 3(behind+idle 决策)+ Task 5(`session/event`/`jobs.list` 接线);§4 ff-only/diverged 拒绝/install-build 失败回滚在自动路径同样生效 → 复用 M2 pipeline(Task 3 只筛 `behind` 入 plan,diverged 不动;Global Constraints 明列);§5 `dsh_update_cancel` → Task 1 + Task 5 注册;§5「不代重启」→ Task 4 `pendingRestart` + Task 5 透出;§6「连续失败不刷屏」→ Task 3 attemptedVersions 同版本不重试;§8 里程碑 4 拆分 → Task 5 Step 3 spec 同步。§5 Web 面板明确拆至 M5,不在本计划。
- **占位符**:无 TBD;假时钟(idle)、attempted 存储(auto-apply)、fixture 均给出完整代码;`ctx.on` 返回值不确定性以「两种皆安全」的显式条件处理,非占位。
- **类型一致**:`updateState.snapshot()` 返回 `{running,log,lastResult,pendingRestart}`(Task 4 定义 → Task 1 `getSnapshot` 读 `.running`、Task 5 透出一致);`startUpdate(plan, exec?)` 的 plan 形状 `{target:'harness',path,behind}|{target,behind}`(M2 `run-tool.js` 既有 → Task 3 auto-apply 构造 → Task 5 注入,三处一致);CheckResult 的 `remoteRef` 字段(M1 定义)→ Task 3 用作 attempted key 的 value,一致;`createIdleTracker`(Task 2)/`createAutoApplier`(Task 3)/`createCancelTool`(Task 1)签名 → Task 5 消费一致。
- **与 M2 的衔接**:`begin()` 互斥锁被手动 `dsh_update_run` 与自动 `maybeAutoApply` 共用,自动撞手动得 `already running` 跳过;取消复用 M2 job cancel hook 与 install/build 期回滚,无新回滚代码。
