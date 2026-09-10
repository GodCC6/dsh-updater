# dsh-updater M2 实现计划(git 形态更新:ff-only pull + install/build + 回滚 + dsh_update_run 后台任务)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M2:在 git 形态下,经 `dsh_update_run` 确认后对本体执行 `pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build`(失败回滚),对 integrations 逐仓 ff-only 更新,以 `ctx.jobs` 后台任务运行并由 `dsh_update_status` 汇报阶段。

**Architecture:** 纯逻辑(更新编排)与 I/O(execFile)分离,延续 M1 的依赖注入模式;`dsh_update_run` 只做门禁判定(unsupported shape / nothing-to-do / already-running / diverged),实际更新经 `ctx.jobs.start` 以后台 job 执行,阶段日志落在插件内共享的 update-state,由 status 工具输出中的 `update` 字段透出。回滚以「pull 前捕获的 HEAD sha」实现 spec §4 的 ORIG_HEAD 意图。

**Tech Stack:** Node >= 20 ESM、`node:test`(零测试依赖)、`execFile`(数组参数,支持 AbortSignal)、真实临时 git 仓 + 假 pnpm 脚本做注入测试;零第三方依赖。

**Spec:** `/Users/dmall/Projects/dsh-updater/docs/superpowers/specs/2026-09-09-dsh-updater-plugin-design.md`(§2 git 更新策略、§3 integrations、§4 触发与安全、§5 工具、§6 错误处理、§8 里程碑 2)

> **勘误注记(2026-09-10,执行后回填)**:本计划文本未回写执行期修正,以 git 历史为准——①三处测试 fixture 缺陷(basePair 的 local-base 矛盾 ×2、Task 3 origin 误入 root)已按裁定在实现中修正;②Task 2 回滚的 `reset --hard` 剥离已 abort 的 signal(commit `0af3b0d`,否则取消时回滚恒失败);③终审后新增脏树门禁(`status --porcelain` 非空拒绝 pull,commit `9381d8c`)与 pipeline finish 必达防护。阅读本计划时以仓内最终代码为准。

## Global Constraints

- 仓位置:`/Users/dmall/Projects/dsh-updater`(下文以 `$R` 指代;bash 步骤一律绝对路径,不 `cd`)。
- 纯 JS ESM(`.js`,`"type": "module"`),零第三方依赖,无 build 步骤。
- 所有外部命令用 `execFile`(数组参数)+ 超时,禁止 shell 拼接;`pnpm`/`git` bin 名可注入便于测试。
- **M2 仍是确认门**:`autoApply` 不实现(M4);`dsh_update_run` 本身即用户确认入口。
- **更新目标只来自探测结果**:本体 = `detectInstallShape` 得出的 harnessRoot;integrations = `~/.dsh/integrations` 枚举;工具与 pipeline 不接收自由路径(spec §9)。
- `pull` 仅 `--ff-only`;本地 diverged 直接拒绝不动(spec §4);install/build 任一失败 → `git reset --hard <pull 前捕获 sha>` 回滚(spec §4 ORIG_HEAD 意图;捕获 sha 比 ORIG_HEAD 更稳,语义一致)。
- 取消(abort)发生在 install/build 期间时同样尽力回滚,再向上抛取消标记——绝不留半更新状态(spec §6)。
- integrations 更新互相独立:单仓 diverged/failed 不影响其他仓,逐仓汇报(spec §3)。
- 测试命令统一:`node --test --test-reporter=spec "$R"/test/*.test.js`(显式 glob;目录位置参数在 Node ≥22 有回归)。
- config 不新增字段(`autoApply`/`idleQuietMs` 留待 M4);`cordis.patch.yml` 不改。

---

### Task 1: lib/git-update.js — 单仓 ff-only 更新原语

**Files:**
- Create: `$R/lib/git-update.js`
- Test: `$R/test/git-update.test.js`

**Interfaces:**
- Produces: `updateGitRepo({ path, gitBin = 'git', signal }): Promise<UpdateResult>`,其中

```js
// UpdateResult
{
  target: string,        // 仓路径
  status: 'updated' | 'up-to-date' | 'diverged' | 'failed',
  fromSha: string,       // 操作前 HEAD 短 sha;取不到为 null
  toSha: string,         // 操作后 HEAD 短 sha;未更新时 === fromSha;failed/diverged 为 null
  ahead: number,         // 决策时的 @{upstream}..HEAD 计数
  behind: number,        // 决策时的 HEAD..@{upstream} 计数
  error?,                // status='failed' 时 stderr 首行或说明
}
```

- 流程:`fetch --quiet` → `rev-parse HEAD`(fromSha)→ `rev-parse @{upstream}`(无 upstream → failed 'no upstream configured')→ 双向 `rev-list --count` → `ahead>0 && behind>0` → diverged(不动);`behind===0` → up-to-date;否则 `pull --ff-only --quiet` → 重读 HEAD → updated。
- **取消语义**:abort 触发的 AbortError 不吞——重新抛出带 `cancelled: true` 标记的 Error,由上层(Task 4 pipeline)处理;其余错误归入 `failed`,绝不抛出。
- Consumes: 无(独立原语)。

- [ ] **Step 1: 写失败测试**

`$R/test/git-update.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { updateGitRepo } from '../lib/git-update.js'

function sh(repo, ...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}
function commit(repo, file, msg) {
  writeFileSync(join(repo, file), 'x\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg)
}
function head(repo) {
  return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
}
// 基础仓:origin(init + 1 commit) + work(clone)。`git -C work clone` 前必须 mkdirSync(work)
function basePair() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-upd-'))
  const origin = join(base, 'origin'), work = join(base, 'work')
  mkdirSync(origin); mkdirSync(work)
  sh(origin, 'init', '-b', 'main')
  commit(origin, 'a.txt', 'init')
  sh(work, 'clone', origin, '.')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local-base')
  return { origin, work }
}

test('behind repo gets fast-forwarded to upstream', async () => {
  const { origin, work } = basePair()
  commit(origin, 'b.txt', 'remote advance')
  const r = await updateGitRepo({ path: work })
  assert.equal(r.status, 'updated')
  assert.equal(r.behind, 1)
  assert.equal(r.toSha, head(work))
  assert.notEqual(r.toSha, r.fromSha)
})

test('up-to-date repo is a no-op', async () => {
  const { work } = basePair()
  const before = head(work)
  const r = await updateGitRepo({ path: work })
  assert.equal(r.status, 'up-to-date')
  assert.equal(r.toSha, before)
  assert.equal(head(work), before)
})

test('diverged repo is refused untouched', async () => {
  const { origin, work } = basePair()
  const before = head(work)
  commit(origin, 'b.txt', 'remote advance') // 本地已有 local-base 提交 → diverged
  const r = await updateGitRepo({ path: work })
  assert.equal(r.status, 'diverged')
  assert.ok(r.ahead >= 1 && r.behind >= 1)
  assert.equal(head(work), before)
})

test('non-repo path → failed with error, never throws', async () => {
  const r = await updateGitRepo({ path: '/nonexistent-repo-xyz' })
  assert.equal(r.status, 'failed')
  assert.ok(r.error)
})

test('repo without upstream → failed with explanatory error', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-upd-'))
  const lone = join(base, 'lone')
  mkdirSync(lone)
  sh(lone, 'init', '-b', 'main')
  commit(lone, 'a.txt', 'init')
  const r = await updateGitRepo({ path: lone })
  assert.equal(r.status, 'failed')
  assert.match(r.error, /upstream/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/git-update.test.js`
Expected: FAIL(`Cannot find module .../lib/git-update.js`)

- [ ] **Step 3: 实现 `$R/lib/git-update.js`**

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExec = promisify(execFile)

function cancelledError() {
  const err = new Error('update cancelled')
  err.cancelled = true
  return err
}

async function git(path, args, gitBin, signal) {
  const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 120000, signal })
  return stdout.trim()
}

export async function updateGitRepo({ path, gitBin = 'git', signal } = {}) {
  const base = { target: path, fromSha: null, toSha: null, ahead: 0, behind: 0 }
  try {
    await git(path, ['fetch', '--quiet'], gitBin, signal)
    const fromSha = await git(path, ['rev-parse', '--short', 'HEAD'], gitBin, signal)
    let upstreamSha
    try { upstreamSha = await git(path, ['rev-parse', '--short', '@{upstream}'], gitBin, signal) }
    catch { return { ...base, fromSha, status: 'failed', error: 'no upstream configured' } }
    const count = async (range) => parseInt(await git(path, ['rev-list', '--count', range], gitBin, signal), 10)
    const behind = await count('HEAD..@{upstream}')
    const ahead = await count('@{upstream}..HEAD')
    if (ahead > 0 && behind > 0) return { ...base, fromSha, ahead, behind, status: 'diverged' }
    if (behind === 0) return { ...base, fromSha, toSha: fromSha, ahead, behind, status: 'up-to-date' }
    await git(path, ['pull', '--ff-only', '--quiet'], gitBin, signal)
    const toSha = await git(path, ['rev-parse', '--short', 'HEAD'], gitBin, signal)
    return { ...base, fromSha, toSha, ahead, behind, status: 'updated' }
  } catch (e) {
    if (e?.name === 'AbortError') throw cancelledError()
    return { ...base, status: 'failed', error: String(e.stderr || e.message).split('\n')[0] }
  }
}
```

(upstreamSha 变量当前未再使用,保留赋值以便调试断言;不引入 lint 依赖。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/git-update.test.js`
Expected: 5 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/git-update.js test/git-update.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: ff-only git repo update primitive with diverged refusal"
```

---

### Task 2: lib/harness-update.js — 本体三步更新 + 失败回滚

**Files:**
- Create: `$R/lib/harness-update.js`
- Test: `$R/test/harness-update.test.js`

**Interfaces:**
- Consumes: Task 1 `updateGitRepo`。
- Produces: `runHarnessUpdate({ path, pnpmBin = 'pnpm', gitBin = 'git', signal }): Promise<HarnessUpdateResult>`,其中

```js
// HarnessUpdateResult
{
  ok: boolean,          // pull(需要时)+ install + build 全部成功
  rolledBack: boolean,  // 是否执行过 reset --hard 回滚
  cancelled: boolean,   // 因 abort 中止(此时已尽力回滚)
  fromSha: string,      // 进入前的 HEAD 短 sha
  toSha: string,        // 结束时 HEAD 短 sha(回滚后 === fromSha)
  steps: [              // 逐步结果(spec §5「返回逐步结果」)
    { step: 'pull' | 'install' | 'build' | 'rollback', status: string, error?, detail? },
  ],
}
```

- 流程:捕获 preSha → `updateGitRepo` → diverged/failed → 直接返回(ok:false,**不回滚**——树未动);up-to-date → ok:true 跳过 install/build;updated → `pnpm install --frozen-lockfile` → `pnpm build`;任一失败或 abort → 尽力 `git reset --hard preSha`(rollback 步骤自身失败则原样向上抛)→ ok:false。
- **取消语义**:abort 发生在 install/build 时,先尽力回滚再抛 `cancelled` 标记错误;发生在 pull 时由 Task 1 抛出(树未动,无需回滚)。
- pnpm 以 `execFile(pnpmBin, args, { cwd: path })` 执行;install 超时 600000ms、build 超时 600000ms。

- [ ] **Step 1: 写失败测试**

`$R/test/harness-update.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runHarnessUpdate } from '../lib/harness-update.js'

function sh(repo, ...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}
function commit(repo, file, msg) {
  writeFileSync(join(repo, file), 'x\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg)
}
function head(repo) {
  return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
}
function basePair() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-hu-'))
  const origin = join(base, 'origin'), work = join(base, 'work')
  mkdirSync(origin); mkdirSync(work)
  sh(origin, 'init', '-b', 'main')
  commit(origin, 'a.txt', 'init')
  sh(work, 'clone', origin, '.')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local-base')
  return { origin, work }
}
// 假 pnpm:记录调用参数到 log 文件;failOn 匹配首个参数时 exit 1
function fakePnpm(failOn = null) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-up-pnpm-'))
  const bin = join(dir, 'fake-pnpm')
  const log = join(dir, 'calls.log')
  writeFileSync(bin, `#!/bin/sh\necho "$1" >> '${log}'\n[ "${failOn}" != "$1" ]\n`)
  chmodSync(bin, 0o755)
  return { bin, log }
}
function pnpmCalls(log) {
  try { return readFileSync(log, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}

test('full success: pull + install + build, HEAD advances', async () => {
  const { origin, work } = basePair()
  commit(origin, 'b.txt', 'remote advance')
  const before = head(work)
  const { bin, log } = fakePnpm()
  const r = await runHarnessUpdate({ path: work, pnpmBin: bin })
  assert.equal(r.ok, true)
  assert.equal(r.rolledBack, false)
  assert.deepEqual(pnpmCalls(log), ['install', 'build'])
  assert.equal(head(work), r.toSha)
  assert.notEqual(r.toSha, before)
  assert.deepEqual(r.steps.map(s => s.step), ['pull', 'install', 'build'])
})

test('build failure rolls back to pre-pull HEAD', async () => {
  const { origin, work } = basePair()
  commit(origin, 'b.txt', 'remote advance')
  const before = head(work)
  const { bin } = fakePnpm('build')
  const r = await runHarnessUpdate({ path: work, pnpmBin: bin })
  assert.equal(r.ok, false)
  assert.equal(r.rolledBack, true)
  assert.equal(head(work), before)
  assert.equal(r.toSha, before)
  assert.ok(r.steps.some(s => s.step === 'rollback' && s.status === 'ok'))
})

test('install failure rolls back and skips build', async () => {
  const { origin, work } = basePair()
  commit(origin, 'b.txt', 'remote advance')
  const before = head(work)
  const { bin, log } = fakePnpm('install')
  const r = await runHarnessUpdate({ path: work, pnpmBin: bin })
  assert.equal(r.ok, false)
  assert.equal(r.rolledBack, true)
  assert.equal(head(work), before)
  assert.deepEqual(pnpmCalls(log), ['install'])
})

test('up-to-date: install/build are not run', async () => {
  const { work } = basePair()
  const before = head(work)
  const { bin, log } = fakePnpm()
  const r = await runHarnessUpdate({ path: work, pnpmBin: bin })
  assert.equal(r.ok, true)
  assert.deepEqual(pnpmCalls(log), [])
  assert.deepEqual(r.steps.map(s => s.step), ['pull'])
  assert.equal(r.toSha, before)
})

test('abort before start propagates cancelled marker', async () => {
  const { work } = basePair()
  const c = new AbortController(); c.abort()
  await assert.rejects(() => runHarnessUpdate({ path: work, signal: c.signal }), (e) => e.cancelled === true)
})

test('diverged: refused, pnpm never invoked, nothing rolled back', async () => {
  const { origin, work } = basePair()
  const { bin, log } = fakePnpm()
  commit(origin, 'b.txt', 'remote advance')
  const r = await runHarnessUpdate({ path: work, pnpmBin: bin })
  assert.equal(r.ok, false)
  assert.equal(r.rolledBack, false)
  assert.deepEqual(pnpmCalls(log), [])
  assert.equal(r.steps[0].step, 'pull')
  assert.equal(r.steps[0].status, 'diverged')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/harness-update.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/harness-update.js`**

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { updateGitRepo } from './git-update.js'

const pExec = promisify(execFile)

function cancelledError() {
  const err = new Error('update cancelled')
  err.cancelled = true
  return err
}

export async function runHarnessUpdate({ path, pnpmBin = 'pnpm', gitBin = 'git', signal } = {}) {
  const git = async (...args) => {
    const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 120000, signal })
    return stdout.trim()
  }
  const rollback = async (steps) => {
    try {
      await git('reset', '--hard', steps.preSha)
      steps.push({ step: 'rollback', status: 'ok', detail: `reset --hard ${steps.preSha}` })
      return true
    } catch (e) {
      steps.push({ step: 'rollback', status: 'failed', error: String(e.stderr || e.message).split('\n')[0] })
      return false
    }
  }
  const preSha = await (async () => {
    try { return await git('rev-parse', '--short', 'HEAD') }
    catch (e) {
      if (e?.name === 'AbortError') throw cancelledError() // 起始前即取消:无树变更,直接以取消标记上抛
      throw e
    }
  })()
  const steps = []
  steps.preSha = preSha // 供 rollback 闭包读取的附着字段,不参与序列化语义
  const pull = await updateGitRepo({ path, gitBin, signal })
  steps.push({ step: 'pull', status: pull.status, fromSha: pull.fromSha, toSha: pull.toSha, error: pull.error })
  if (pull.status === 'diverged' || pull.status === 'failed') {
    delete steps.preSha
    return { ok: false, rolledBack: false, cancelled: false, fromSha: preSha, toSha: preSha, steps }
  }
  if (pull.status === 'up-to-date') {
    delete steps.preSha
    return { ok: true, rolledBack: false, cancelled: false, fromSha: preSha, toSha: preSha, steps }
  }
  const runPnpm = async (args, step) => {
    try {
      await pExec(pnpmBin, args, { cwd: path, timeout: 600000, signal })
      steps.push({ step, status: 'ok' })
      return true
    } catch (e) {
      if (e?.name === 'AbortError') {
        await rollback(steps) // 尽力回滚,再抛取消
        throw cancelledError()
      }
      steps.push({ step, status: 'failed', error: String(e.stderr || e.message).split('\n')[0] })
      return false
    }
  }
  let ok = await runPnpm(['install', '--frozen-lockfile'], 'install')
  if (ok) ok = await runPnpm(['build'], 'build')
  let rolledBack = false
  if (!ok) rolledBack = await rollback(steps)
  delete steps.preSha
  const toSha = await git('rev-parse', '--short', 'HEAD')
  return { ok, rolledBack, cancelled: false, fromSha: preSha, toSha, steps }
}
```

(实现者注意:`steps` 数组上附着 `preSha` 是为了 rollback 闭包取值,返回前 `delete`;若你偏好更朴素的写法,可把 preSha 作为参数传入 rollback——两种皆可,测试为准。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/harness-update.test.js`
Expected: 6 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/harness-update.js test/harness-update.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: harness update pipeline with rollback on install/build failure"
```

---

### Task 3: lib/integrations-update.js — integrations 逐仓独立更新

**Files:**
- Create: `$R/lib/integrations-update.js`
- Test: `$R/test/integrations-update.test.js`

**Interfaces:**
- Consumes: Task 1 `updateGitRepo`;M1 `listIntegrationRepos`(`lib/integrations.js`)。
- Produces: `runIntegrationsUpdate({ root, gitBin = 'git', signal, onTarget }): Promise<IntegrationUpdateResult[]>`,顺序逐仓更新,每仓产出 `{ name, path, ...UpdateResult }`;`onTarget(entry)` 每仓回调一次(pipeline 用它写阶段日志);单仓抛出取消标记时整体向上抛,其余仓错误已归入各自 `failed`。

- [ ] **Step 1: 写失败测试**

`$R/test/integrations-update.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runIntegrationsUpdate } from '../lib/integrations-update.js'

function sh(repo, ...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}
function commit(repo, file, msg) {
  writeFileSync(join(repo, file), 'x\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg)
}
// fixture root:repo-a(落后 1)、repo-b(最新)、plain(非 git,应被跳过)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-up-iu-'))
  for (const name of ['repo-a', 'repo-b']) {
    const origin = join(root, `${name}-origin`), work = join(root, name)
    mkdirSync(origin); mkdirSync(work)
    sh(origin, 'init', '-b', 'main')
    commit(origin, 'a.txt', 'init')
    sh(work, 'clone', origin, '.')
    mkdirSync(join(root, `${name}-origin`), { recursive: true })
  }
  commit(join(root, 'repo-a-origin'), 'b.txt', 'remote advance') // repo-a 落后
  mkdirSync(join(root, 'plain'))
  return { root, originA: join(root, 'repo-a-origin') }
}

test('updates behind repo, skips up-to-date, ignores non-git dir', async () => {
  const { root } = fixture()
  const seen = []
  const results = await runIntegrationsUpdate({ root, onTarget: (e) => seen.push(e.name) })
  assert.deepEqual(seen.sort(), ['repo-a', 'repo-b'])
  const a = results.find(r => r.name === 'repo-a')
  const b = results.find(r => r.name === 'repo-b')
  assert.equal(a.status, 'updated')
  assert.equal(b.status, 'up-to-date')
  assert.equal(results.length, 2)
})

test('diverged integration is reported, other repos still updated', async () => {
  const { root, originA } = fixture()
  const workA = join(root, 'repo-a')
  execFileSync('git', ['-C', workA, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local'], { stdio: 'pipe' })
  const results = await runIntegrationsUpdate({ root })
  const a = results.find(r => r.name === 'repo-a')
  assert.equal(a.status, 'diverged')
  assert.equal(results.find(r => r.name === 'repo-b').status, 'up-to-date')
})

test('missing root yields empty array', async () => {
  assert.deepEqual(await runIntegrationsUpdate({ root: '/nonexistent-iu-root' }), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/integrations-update.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/integrations-update.js`**

```js
import { listIntegrationRepos } from './integrations.js'
import { updateGitRepo } from './git-update.js'

export async function runIntegrationsUpdate({ root, gitBin = 'git', signal, onTarget } = {}) {
  const repos = listIntegrationRepos({ root })
  const results = []
  for (const repo of repos) {
    const r = await updateGitRepo({ path: repo.path, gitBin, signal })
    const entry = { name: repo.name, path: repo.path, ...r }
    results.push(entry)
    onTarget?.(entry)
  }
  return results
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/integrations-update.test.js`
Expected: 3 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/integrations-update.js test/integrations-update.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: per-repo independent integrations update"
```

---

### Task 4: lib/update-state.js + lib/update-run.js — 运行状态与后台 pipeline

**Files:**
- Create: `$R/lib/update-state.js`
- Create: `$R/lib/update-run.js`
- Test: `$R/test/update-run.test.js`

**Interfaces:**
- Produces: `createUpdateState(): UpdateState`,方法:
  - `begin(): boolean` — 无运行中更新时置 running、新建 AbortController、清空日志并返回 true;否则返回 false。
  - `abort(reason)` — 触发当前 AbortController(幂等)。
  - `signal` — 当前 AbortSignal(未运行时为 undefined)。
  - `stage({ target, step, status, detail? })` — 追加一条阶段日志(带 `at: Date.now()`)。
  - `finish(summary)` — running=false,记录 `lastResult = { finishedAt, ...summary }`。
  - `snapshot(): { running, log, lastResult }` — 只读投影(log 为浅拷贝)。
- Produces: `runUpdatePipeline({ updateState, harnessPath, integrationsRoot, gitBin, pnpmBin, runHarnessUpdateImpl, runIntegrationsUpdateImpl }): Promise<UpdateSummary>` — 前提:调用方已 `updateState.begin()`。顺序执行本体(`harnessPath` 为 null 时跳过)与 integrations,逐段 `stage`;捕获取消标记与意外错误;结束时 `finish` 并返回

```js
// UpdateSummary
{
  ok: boolean,        // 未取消 且 本体 ok 且 每个集成仓 updated/up-to-date
  cancelled: boolean,
  harness: HarnessUpdateResult | null,
  integrations: IntegrationUpdateResult[],
}
```

- `runHarnessUpdateImpl`/`runIntegrationsUpdateImpl` 为可注入覆盖(默认真实现),供 pipeline 单测。

- [ ] **Step 1: 写失败测试**

`$R/test/update-run.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateState } from '../lib/update-state.js'
import { runUpdatePipeline } from '../lib/update-run.js'

const OK_HARNESS = { ok: true, rolledBack: false, cancelled: false, fromSha: 'a', toSha: 'b', steps: [] }

test('happy path: stages recorded, finish summary ok', async () => {
  const state = createUpdateState()
  assert.equal(state.begin(), true)
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => {
      state.stage({ target: '/harness', step: 'pull', status: 'ok' })
      return OK_HARNESS
    },
    runIntegrationsUpdateImpl: async () => [],
  })
  assert.equal(summary.ok, true)
  assert.equal(summary.cancelled, false)
  assert.equal(state.snapshot().running, false)
  assert.ok(state.snapshot().log.some(e => e.step === 'pull'))
  assert.ok(state.snapshot().lastResult.finishedAt > 0)
})

test('begin refuses concurrent run; finish re-opens', async () => {
  const state = createUpdateState()
  assert.equal(state.begin(), true)
  assert.equal(state.begin(), false)
  state.finish({ ok: true })
  assert.equal(state.begin(), true)
})

test('harness failure → ok:false, integrations still run', async () => {
  const state = createUpdateState()
  state.begin()
  let intsRan = false
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => ({ ok: false, rolledBack: true, cancelled: false, fromSha: 'a', toSha: 'a', steps: [] }),
    runIntegrationsUpdateImpl: async () => { intsRan = true; return [{ name: 'x', status: 'updated' }] },
  })
  assert.equal(summary.ok, false)
  assert.equal(intsRan, true)
  assert.equal(summary.integrations[0].status, 'updated')
})

test('cancel marker from harness → summary.cancelled, integrations skipped', async () => {
  const state = createUpdateState()
  state.begin()
  const err = new Error('update cancelled'); err.cancelled = true
  let intsRan = false
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => { throw err },
    runIntegrationsUpdateImpl: async () => { intsRan = true; return [] },
  })
  assert.equal(summary.cancelled, true)
  assert.equal(summary.ok, false)
  assert.equal(intsRan, false)
  assert.equal(state.snapshot().running, false)
})

test('harnessPath null → integrations only', async () => {
  const state = createUpdateState()
  state.begin()
  let harnessRan = false
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: null,
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => { harnessRan = true; return OK_HARNESS },
    runIntegrationsUpdateImpl: async () => [],
  })
  assert.equal(harnessRan, false)
  assert.equal(summary.harness, null)
  assert.equal(summary.ok, true)
})

test('abort() flips the signal the pipeline sees', async () => {
  const state = createUpdateState()
  state.begin()
  assert.equal(state.signal.aborted, false)
  state.abort('test')
  assert.equal(state.signal.aborted, true)
  state.finish({ ok: false, cancelled: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/update-run.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/update-state.js`**

```js
export function createUpdateState() {
  let running = false
  let controller = null
  let log = []
  let lastResult = null
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
    snapshot() {
      return { running, log: [...log], lastResult }
    },
  }
}
```

- [ ] **Step 4: 实现 `$R/lib/update-run.js`**

```js
import { runHarnessUpdate } from './harness-update.js'
import { runIntegrationsUpdate } from './integrations-update.js'

export async function runUpdatePipeline({
  updateState,
  harnessPath,
  integrationsRoot,
  gitBin = 'git',
  pnpmBin = 'pnpm',
  runHarnessUpdateImpl = runHarnessUpdate,
  runIntegrationsUpdateImpl = runIntegrationsUpdate,
}) {
  const signal = updateState.signal
  updateState.stage({ target: 'pipeline', step: 'start', status: 'ok' })
  let harness = null
  let integrations = []
  let cancelled = false
  let unexpected = null
  try {
    if (harnessPath) {
      harness = await runHarnessUpdateImpl({ path: harnessPath, pnpmBin, gitBin, signal })
      updateState.stage({
        target: harnessPath, step: 'harness', status: harness.ok ? 'ok' : 'failed',
        detail: `rolledBack=${harness.rolledBack}`,
      })
      if (harness.cancelled) cancelled = true
    }
    if (!cancelled) {
      integrations = await runIntegrationsUpdateImpl({
        root: integrationsRoot, gitBin, signal,
        onTarget: (e) => updateState.stage({
          target: e.path, step: 'integration', status: e.status === 'updated' || e.status === 'up-to-date' ? 'ok' : e.status,
        }),
      })
    }
  } catch (e) {
    if (e?.cancelled) cancelled = true
    else unexpected = String(e?.message ?? e)
  }
  if (unexpected) updateState.stage({ target: 'pipeline', step: 'error', status: 'failed', detail: unexpected })
  const ok = !cancelled && !unexpected
    && (harness === null || harness.ok === true)
    && integrations.every(r => r.status === 'updated' || r.status === 'up-to-date')
  const summary = { ok, cancelled, harness, integrations }
  updateState.finish(summary)
  return summary
}
```

(取消后跳过 integrations:本体被中止意味着用户要停,不再继续下一目标。)

- [ ] **Step 5: 跑全量测试确认通过**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 此前全部 PASS + 新增 6 个 PASS

- [ ] **Step 6: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/update-state.js lib/update-run.js test/update-run.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: update run state and background pipeline orchestration"
```

---

### Task 5: lib/run-tool.js — dsh_update_run 门禁 + status 工具透传 update 字段

**Files:**
- Create: `$R/lib/run-tool.js`
- Modify: `$R/lib/tool.js`(`collectStatus` 返回的额外字段(如 `update`)透传进输出)
- Test: `$R/test/run-tool.test.js`
- Test: `$R/test/tool.test.js`(追加一条透传断言)

**Interfaces:**
- Consumes: M1 `collectStatus` 的 `{ shape, checks }`(CheckResult:status/behindCount/target/kind)。
- Produces: `createRunTool({ collectStatus, startUpdate })` → 工具 `dsh_update_run`:
  - `startUpdate(plan, exec): { jobId }` — 由 index.js 注入(真实实现走 `ctx.jobs.start`);抛错视为启动失败。
  - 门禁(spec §4/§5):shape 非 git → 拒绝(npm 形态 M3);harness `behind` 入计划,`diverged`/其他状态 → skipped(带原因);integrations 逐仓同判;计划为空 → `started:false, reason:'nothing to update'`;`already running` 由 startUpdate 抛错路径返回。
  - execute 返回 JSON 字符串:`{ started, jobId?, plan?, skipped?, reason?, note? }`,`note` 固定提示「更新完成后重启 dsh 生效」。
- Modify `lib/tool.js`:createStatusTool 输出追加 `...extra`(collectStatus 的剩余字段),使 `update` 快照随 status 输出。

- [ ] **Step 1: 写失败测试**

`$R/test/run-tool.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunTool } from '../lib/run-tool.js'

const SHAPE_GIT = { kind: 'git', harnessRoot: '/harness' }

function fakeCollect({ shape = SHAPE_GIT, harnessStatus = 'behind', ints = [] } = {}) {
  const checks = []
  if (harnessStatus) checks.push({ target: '/harness', kind: 'harness-git', status: harnessStatus, behindCount: harnessStatus === 'behind' ? 3 : 0 })
  for (const [name, status] of ints) checks.push({ target: `/ints/${name}`, kind: 'integration', status, behindCount: status === 'behind' ? 1 : 0 })
  return async () => ({ shape, checks })
}

test('behind harness starts update with jobId', async () => {
  const tool = createRunTool({ collectStatus: fakeCollect({}), startUpdate: async () => ({ jobId: 'dsh-update-1' }) })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, true)
  assert.equal(out.jobId, 'dsh-update-1')
  assert.deepEqual(out.plan, [{ target: 'harness', path: '/harness', behind: 3 }])
  assert.match(out.note, /restart/i)
})

test('nothing behind → refuse without starting', async () => {
  let called = false
  const tool = createRunTool({
    collectStatus: fakeCollect({ harnessStatus: 'up-to-date' }),
    startUpdate: async () => { called = true; return { jobId: 'x' } },
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, false)
  assert.match(out.reason, /nothing to update/)
  assert.equal(called, false)
})

test('diverged harness is skipped with reason; behind integrations still planned', async () => {
  const tool = createRunTool({
    collectStatus: fakeCollect({ harnessStatus: 'diverged', ints: [['sp', 'behind']] }),
    startUpdate: async () => ({ jobId: 'j1' }),
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, true)
  assert.deepEqual(out.plan, [{ target: '/ints/sp', behind: 1 }])
  assert.match(out.skipped[0].reason, /diverged/)
})

test('non-git shape → refused (npm form is M3)', async () => {
  const tool = createRunTool({
    collectStatus: fakeCollect({ shape: { kind: 'unknown' }, harnessStatus: null }),
    startUpdate: async () => ({ jobId: 'x' }),
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, false)
  assert.match(out.reason, /unsupported install shape/)
})

test('startUpdate throw → started:false with reason', async () => {
  const tool = createRunTool({
    collectStatus: fakeCollect({}),
    startUpdate: async () => { throw new Error('an update is already running') },
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, false)
  assert.match(out.reason, /already running/)
})
```

`$R/test/tool.test.js` 追加:

```js
test('extra collectStatus fields (update snapshot) pass through', async () => {
  const tool = createStatusTool({ collectStatus: async () => ({ ...FAKE, update: { running: true, log: [{ at: 1, target: '/x', step: 'pull', status: 'ok' }] } }) })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.update.running, true)
  assert.equal(out.update.log[0].step, 'pull')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/run-tool.test.js /Users/dmall/Projects/dsh-updater/test/tool.test.js`
Expected: run-tool FAIL(模块不存在);tool 新增用例 FAIL(update 字段缺失)

- [ ] **Step 3: 实现 `$R/lib/run-tool.js`**

```js
export function createRunTool({ collectStatus, startUpdate }) {
  return {
    name: 'dsh_update_run',
    description: 'Run the checked updates now: git-form harness (pull --ff-only, pnpm install --frozen-lockfile, pnpm build, rollback on failure) plus fast-forward integration repos. Refuses when up-to-date, diverged, or already running. Runs as a background job; check dsh_update_status for progress.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const { shape, checks } = await collectStatus({})
      if (shape.kind !== 'git') {
        return JSON.stringify({ started: false, reason: `unsupported install shape: ${shape.kind} (npm form lands in M3)` }, null, 2)
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
      if (plan.length === 0) {
        return JSON.stringify({ started: false, reason: 'nothing to update', skipped }, null, 2)
      }
      try {
        const { jobId } = await startUpdate(plan, exec)
        return JSON.stringify({
          started: true,
          jobId,
          plan,
          skipped,
          note: 'update runs in the background; check dsh_update_status for progress, restart dsh afterwards to apply the new build',
        }, null, 2)
      } catch (e) {
        return JSON.stringify({ started: false, reason: String(e?.message ?? e), plan, skipped }, null, 2)
      }
    },
  }
}
```

- [ ] **Step 4: 修改 `$R/lib/tool.js` 透传额外字段**

`execute` 内,把

```js
      const { shape, checks } = await collectStatus({})
```

改为

```js
      const { shape, checks, ...extra } = await collectStatus({})
```

并把返回对象的 `checks` 之后追加 `...extra`:

```js
      return JSON.stringify({
        shape,
        summary,
        checks: detail ? checks : checks.map(({ localRef, remoteRef, ...rest }) => rest),
        ...extra,
      }, null, 2)
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/run-tool.test.js /Users/dmall/Projects/dsh-updater/test/tool.test.js`
Expected: run-tool 5 个 PASS;tool 3 个 PASS

- [ ] **Step 6: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/run-tool.js lib/tool.js test/run-tool.test.js test/tool.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: dsh_update_run gating tool and update snapshot passthrough in status"
```

---

### Task 6: index.js 装配(ctx.jobs 后台任务)+ 全量验证 + 真机验收

**Files:**
- Modify: `$R/index.js`(整体替换)
- Modify: `$R/README.md`(M2 行为一段:更新动作、回滚、重启提示)

**Interfaces:**
- Consumes: Task 4 `createUpdateState`/`runUpdatePipeline`;Task 5 `createRunTool`;M1 `collectStatus`/`createStatusTool`。
- Produces: 插件装配——`inject = ['tools', 'jobs']`;`startUpdate(plan, exec)`:
  1. `updateState.begin()` 为 false → throw 'an update is already running'。
  2. `ctx.jobs.start({ kind: 'dsh-update', label, owner: exec?.agent, run() {...} })`;`jobs.start` 抛错(如无 job controller)→ `updateState.finish({ ok:false, ... })` 后原样抛出。
  3. producer `run()`:body = `runUpdatePipeline({ updateState, harnessPath: plan.find(t => t.target === 'harness')?.path ?? null, integrationsRoot: expandHome(cfg.integrationsDir), gitBin: 'git', pnpmBin: 'pnpm' })`;`done` 映射为 `{ status: cancelled ? 'killed' : ok ? 'completed' : 'failed', detail, output: JSON.stringify(summary) }`;`cancel: () => updateState.abort('cancelled by user')`。
- status 工具的 `collectStatus` 换成带 `update: updateState.snapshot()` 的包装;run 工具以真实 startUpdate 注册。
- kind 说明:registry 对 kind 只要求非空字符串(`jobs-local/src/index.ts:135`),job id 形如 `dsh-update-N`;job controller 由 profile 组成中的 `@deepseek-ai/dsh-tool-jobs` 提供(web profile 已含,验证见 Step 4)。

- [ ] **Step 1: 整体替换 `$R/index.js`**

```js
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectStatus } from './lib/status.js'
import { createStatusTool } from './lib/tool.js'
import { createRunTool } from './lib/run-tool.js'
import { createUpdateState } from './lib/update-state.js'
import { runUpdatePipeline } from './lib/update-run.js'

export const name = 'dsh-updater'
// 工具注册要等 tools 服务;jobs.start 要等 jobs 服务
export const inject = ['tools', 'jobs']

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
import { join } from 'node:path'

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config }
  const binPath = dshBinPath()
  const updateState = createUpdateState()
  ctx.logger?.info?.('dsh-updater loaded, checkOnStart=%s', cfg.checkOnStart)

  const collect = (opts = {}) => collectStatus({ ...opts, config: cfg, env: { binPath } })
  const collectWithUpdate = async (opts = {}) => ({ ...await collect(opts), update: updateState.snapshot() })

  const runStatus = () => collect()
    .then(({ shape, checks }) => {
      const problems = checks.filter(c => c.status === 'behind' || c.status === 'diverged' || c.status === 'error')
      if (problems.length) ctx.logger?.info?.('dsh-updater: %d update-relevant results (shape=%s)', problems.length, shape.kind)
    })
    .catch(e => ctx.logger?.warn?.('dsh-updater check failed: %s', e?.message ?? e))

  if (cfg.checkOnStart) void runStatus()

  const minutes = Number.isFinite(cfg.checkIntervalMinutes) && cfg.checkIntervalMinutes >= 1 ? cfg.checkIntervalMinutes : 30
  const timer = setInterval(() => void runStatus(), minutes * 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  ctx.tools.register(createStatusTool({ collectStatus: collectWithUpdate }))
  ctx.tools.register(createRunTool({
    collectStatus: collect,
    startUpdate: (plan, exec) => {
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
            }).then(summary => ({
              status: summary.cancelled ? 'killed' : summary.ok ? 'completed' : 'failed',
              detail: summary.cancelled ? 'cancelled' : summary.ok ? 'update finished' : 'update finished with failures; run dsh_update_status for steps',
              output: JSON.stringify(summary, null, 2),
            }), (e) => ({
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
    },
  }))
}
```

(实现者注意:`import { join } from 'node:path'` 应并入文件顶部 import 区,不要散落在中间——上面为对照原文件 diff 方便而就近书写;以 lint 无告警的规范形态落盘。)

- [ ] **Step 2: README.md 追加 M2 行为段**

在现有简介后追加一段(3-5 句):M2 起可通过 `dsh_update_run` 触发 git 形态更新(本体 `pull --ff-only` + `pnpm install --frozen-lockfile` + `pnpm build`,install/build 失败自动 `reset --hard` 回滚;integrations 逐仓 ff-only);更新以后台 job 运行,进度看 `dsh_update_status` 的 `update` 字段;完成后需重启 dsh 生效。npm 形态更新在 M3。

- [ ] **Step 3: 全量测试**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全部 PASS(M1 的 26 + M2 新增 26 = 52 个)

- [ ] **Step 4: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add index.js README.md
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: wire dsh_update_run to background jobs with rollback pipeline"
```

- [ ] **Step 5: 真机验收(命令侧 + 活体)**

```bash
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh plugin --profile web add /Users/dmall/Projects/dsh-updater
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh --profile web --dump-config 2>/dev/null | grep -c "dsh-updater"
```

Expected: add 幂等成功;grep ≥ 1。然后由用户重启 web profile,验收序列:

1. 新会话调 `dsh_update_status`:输出含 `update` 字段(`running:false`)。
2. 调 `dsh_update_run`:当前本体 behind(288)→ 应返回 `started:true, jobId:dsh-update-N` 与计划;**真实更新会改写 harness checkout,必须先获用户明确同意再调用**。
3. 用户同意后:更新期间 `dsh_update_status` 的 `update.log` 可见阶段推进;结束后 harness HEAD 前移、`dsh_update_status` 回到 up-to-date(或上游再进→behind 新计数);job 侧 `job_output` 有 summary。
4. 提示用户重启 dsh 应用新构建。

---

## Self-Review 记录

- **Spec 覆盖**:§2 git 更新策略 → Task 1/2(fetch→ff-check→pull→install→build);§3 integrations 独立更新与逐仓汇报 → Task 3;§4 确认门(`dsh_update_run` 即确认)、ff-only、diverged 拒绝、install/build 失败回滚 → Task 2/5/6;§5 `dsh_update_run` + status「进行中任务的阶段」→ Task 4/5/6(`update` 快照);§6 绝不留半更新(commit 原子 pull + 回滚/取消尽力回滚)、单项失败不拖垮其他目标 → Task 3/4;§8 里程碑 2。§4 自动模式(idle 条件)与 §5 `dsh_update_cancel`/面板属 M4,不在本计划;`cancel` 作为 job runtime 必需 hooks 已随 Task 6 提供(abort 信号),但不注册独立 cancel 工具。
- **占位符**:无 TBD;假 pnpm、假 impl、fixture 均给出完整代码。
- **类型一致**:`UpdateResult`(Task 1)→ Task 3 entry `{ name, path, ...r }` → Task 4 summary.integrations;`HarnessUpdateResult`(Task 2)→ Task 4 summary.harness;`createUpdateState`/`runUpdatePipeline` 签名(Task 4)→ Task 6 消费一致;`createRunTool({ collectStatus, startUpdate })`(Task 5)→ Task 6 注入一致;status 输出新增 `update` 字段(Task 5 透传 → Task 6 注入)。
- **与 M1 修订记录的衔接**:glob 测试命令、绝对路径、零依赖、patch 行 config 不动等约束全部沿用。
