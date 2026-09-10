# dsh-updater M1 实现计划(仓脚手架 + 形态探测 + 只读检查 + dsh_update_status)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立独立插件仓 `~/Projects/dsh-updater`,交付 M1:安装形态探测、git/npm/integrations 只读版本比对,以及 `dsh_update_status` agent 工具。

**Architecture:** 纯 ESM JavaScript cordis 插件,以 `dsh.bundle` 包格式安装进 web profile。纯逻辑模块(探测/比对/聚合)与 I/O(git/npm 子进程)分离,全部可注入路径做单测。工具经 `ctx.tools.register()` 裸 JSON-Schema 注册。

**Tech Stack:** Node >= 20 ESM、`node:test`(零测试依赖)、`execFile` 调 git/npm;无第三方运行时依赖(config 走 patch 行 + 代码兜底,不引 schemastery,理由见 Global Constraints)。

**Spec:** `/Users/dmall/Projects/dsh-updater/docs/superpowers/specs/2026-09-09-dsh-updater-plugin-design.md`(已随 spec 迁入本仓;原 vps-infra 路径已失效)

## Global Constraints

- 仓位置:`/Users/dmall/Projects/dsh-updater`(下文以 `$R` 指代;bash 步骤一律绝对路径,不 `cd`)。
- 纯 JS ESM(`.js`,`"type": "module"`),**不用 TypeScript、无 build 步骤**(publish 指南的 bundle 即此形态)。
- 运行期只读:M1 不执行 pull/install/build,只做 fetch 与 registry 查询。
- 所有外部命令用 `execFile`(数组参数),禁止 shell 拼接。
- 版本比较必须支持 prerelease(`0.1.5-alpha.1` < `0.1.5`)。
- 插件对路径只操作「探测得出」的目标,工具入参不接收自由路径(spec §9)。
- config 默认值经 `cordis.patch.yml` 的 insert 行下发(spec §7 原文即此形态),`index.js` 对各字段再做代码级兜底默认;**不 import schemastery**(`@deepseek-ai/schemastery` 是 harness 内 vendor 的 `link:` 包,对独立 link 安装仓不可靠解析;schema 迁移推迟到出现真实需要)。
- 测试命令统一:`node --test --test-reporter=spec "$R"/test/*.test.js`(显式 glob;不用目录位置参数——Node ≥22 有目录参数回归,本机 v26.7.0 实测把目录当测试文件执行)。

---

### Task 1: 仓脚手架 + bundle 清单 + 安装验证

**Files:**
- Create: `$R/package.json`
- Create: `$R/index.js`
- Create: `$R/cordis.patch.yml`
- Create: `$R/test/smoke.test.js`
- Create: `$R/README.md`
- Create: `$R/.gitignore`(`node_modules/`)

**Interfaces:**
- Produces: 可被后续任务扩展的插件入口 `index.js`,导出 `name`、`apply(ctx, config)`(不导出 Config——config 默认值走 patch 行,见 Global Constraints);bundle 清单使 profile 加载后出现 `dsh-updater` 层。

- [ ] **Step 1: 创建目录与 package.json**

```bash
mkdir -p /Users/dmall/Projects/dsh-updater/test
```

`$R/package.json`:

```json
{
  "name": "dsh-updater",
  "version": "0.1.0",
  "description": "Dual-mode (git checkout / npm global) auto-update plugin for DeepSeek Harness",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "lib/", "cordis.patch.yml"],
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test --test-reporter=spec test/*.test.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- [ ] **Step 2: 写最小 index.js 与 patch 清单**

`$R/index.js`:

```js
export const name = 'dsh-updater'

export function apply(ctx, config) {
  ctx.logger.info('dsh-updater loaded, checkOnStart=%s', config.checkOnStart)
}
```

`$R/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-updater
      name: dsh-updater
      config:
        checkOnStart: true
        checkIntervalMinutes: 30
        autoApply: false
        idleQuietMs: 120000
        npmDistTag: latest
        integrationsDir: '~/.dsh/integrations'
```

(配置默认值常驻 patch 行——这正是 spec §7 的原文形态,patch 是定义该行 config 的唯一层;不迁入 schemastery,理由见 Global Constraints。)

- [ ] **Step 3: 写冒烟测试**

`$R/test/smoke.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, apply } from '../index.js'

test('plugin exports name and apply', () => {
  assert.equal(name, 'dsh-updater')
  assert.equal(typeof apply, 'function')
})

test('apply logs and does not throw', () => {
  const logs = []
  apply({ logger: { info: (m) => logs.push(m) } }, { checkOnStart: true })
  assert.match(logs[0], /dsh-updater loaded/)
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 2 个测试 PASS

- [ ] **Step 5: git init + 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater init
git -C /Users/dmall/Projects/dsh-updater add package.json index.js cordis.patch.yml test/smoke.test.js README.md .gitignore
git -C /Users/dmall/Projects/dsh-updater commit -m "chore: bundle scaffold with smoke test"
```

`$R/README.md` 内容:一段简介(双形态自动更新插件,M1 为只读检查)+ 安装方式(`dsh plugin --profile web add ~/Projects/dsh-updater`)+ 配置字段表(抄 cordis.patch.yml 六个字段)。

- [ ] **Step 6: 安装进 web profile 并验证层出现**

```bash
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh plugin --profile web add /Users/dmall/Projects/dsh-updater
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh --profile web --dump-config 2>/dev/null | grep -c "dsh-updater"
```

Expected: grep 计数 ≥ 1(出现 `# == dsh-updater` 层)。失败时先看 `dsh plugin` 的 stderr。

---

### Task 2: semver 比较器(prerelease 感知)

**Files:**
- Create: `$R/lib/semver.js`
- Test: `$R/test/semver.test.js`

**Interfaces:**
- Produces: `compareVersions(a: string, b: string): -1|0|1`;`isNewer(candidate: string, current: string): boolean`(candidate 更新返回 true;任一解析失败返回 false)。

- [ ] **Step 1: 写失败测试**

`$R/test/semver.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isNewer } from '../lib/semver.js'

test('ordering', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('0.1.5', '0.1.4'), 1)
})

test('prerelease binds lower than release', () => {
  assert.equal(compareVersions('0.1.5-alpha.1', '0.1.5'), -1)
  assert.equal(compareVersions('0.1.5-alpha.2', '0.1.5-alpha.1'), 1)
  assert.equal(compareVersions('0.1.5-alpha.1', '0.1.4'), 1)
})

test('isNewer guards unparseable input', () => {
  assert.equal(isNewer('1.2.3', '1.2.2'), true)
  assert.equal(isNewer('not-a-version', '1.0.0'), false)
  assert.equal(isNewer('1.0.0', ''), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/semver.test.js`
Expected: FAIL(`Cannot find module .../lib/semver.js`)

- [ ] **Step 3: 实现 `$R/lib/semver.js`**

```js
const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parse(v) {
  const m = RE.exec(String(v).trim())
  if (!m) return null
  return {
    major: +m[1], minor: +m[2], patch: +m[3],
    pre: m[4] ? m[4].split('.') : null,
  }
}

function cmpPre(a, b) {
  if (!a && !b) return 0
  if (!a) return 1   // release > prerelease
  if (!b) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { const d = +x - +y; if (d) return Math.sign(d) }
    else if (xn !== yn) { return xn ? -1 : 1 } // 数字段 < 字符串段
    else if (x !== y) { return x < y ? -1 : 1 }
  }
  return 0
}

export function compareVersions(a, b) {
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) throw new Error(`unparseable version: ${!pa ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return Math.sign(pa[k] - pb[k])
  }
  return cmpPre(pa.pre, pb.pre)
}

export function isNewer(candidate, current) {
  try { return compareVersions(candidate, current) > 0 } catch { return false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/semver.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/semver.js test/semver.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: prerelease-aware semver comparator"
```

---

### Task 3: 安装形态探测

**Files:**
- Create: `$R/lib/detect.js`
- Test: `$R/test/detect.test.js`

**Interfaces:**
- Consumes: node:`fs`/`node:path`。
- Produces: `detectInstallShape({ harnessRoot?: string, binPath?: string }): { kind: 'git'|'npm'|'unknown', harnessRoot: string, details: object }`。判定规则(spec §2):显式 `harnessRoot` 有 `.git` **且** `pnpm-workspace.yaml` → `git`;否则从 `dirname(realpath(binPath))` 逐级向上,**任一层先满足 `.git` + `pnpm-workspace.yaml` → `git`**(git 标记优先——源码 checkout 形态下 `apps/cli/package.json` 同名 `@deepseek-ai/dsh`,但它在仓内,不得先判 npm);全程无 git 标记且某层 `package.json` 的 `name === '@deepseek-ai/dsh'` → `npm`(`harnessRoot` 即该包目录);都不中 → `unknown`。bin 路径来源见 Task 8:必须用运行中 dsh 的 `process.argv[1]`,不能用插件自身 `import.meta.url`(`link:` 安装下后者落在本插件仓,永远走不到 harness)。

- [ ] **Step 1: 写失败测试(临时 fixture 目录)**

`$R/test/detect.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectInstallShape } from '../lib/detect.js'

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-up-'))
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
  return dir
}

test('git shape: .git dir + pnpm-workspace.yaml', () => {
  const root = fixture({ '.git/HEAD': 'ref: refs/heads/main', 'pnpm-workspace.yaml': 'packages:\n  - apps\n' })
  const s = detectInstallShape({ harnessRoot: root })
  assert.equal(s.kind, 'git')
  assert.equal(s.harnessRoot, root)
})

test('unknown shape: .git without workspace file', () => {
  const root = fixture({ '.git/HEAD': 'ref: refs/heads/main' })
  assert.equal(detectInstallShape({ harnessRoot: root }).kind, 'unknown')
})

test('npm shape via package name walk-up', () => {
  const root = fixture({
    'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh' }),
  })
  const binPath = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const s = detectInstallShape({ binPath })
  assert.equal(s.kind, 'npm')
  assert.equal(s.details.packageName, '@deepseek-ai/dsh')
})

test('git shape wins when the dsh package sits inside a source checkout', () => {
  const root = fixture({
    '.git/HEAD': 'ref: refs/heads/main',
    'pnpm-workspace.yaml': 'packages: []\n',
    'apps/cli/package.json': JSON.stringify({ name: '@deepseek-ai/dsh' }),
  })
  const s = detectInstallShape({ binPath: join(root, 'apps/cli/bin/dsh.js') })
  assert.equal(s.kind, 'git')
  assert.equal(s.harnessRoot, root)
})

test('no evidence at all → unknown, never throws', () => {
  const s = detectInstallShape({})
  assert.equal(s.kind, 'unknown')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/detect.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/detect.js`**

```js
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const isGitCheckout = (dir) =>
  existsSync(join(dir, '.git')) && existsSync(join(dir, 'pnpm-workspace.yaml'))

function nearestDshPackage(startDir) {
  let dir = startDir
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg?.name === '@deepseek-ai/dsh') return dir
    } catch { /* 无 package.json 或解析失败:继续向上 */ }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function detectInstallShape({ harnessRoot, binPath } = {}) {
  if (harnessRoot) {
    const root = resolve(harnessRoot)
    if (isGitCheckout(root)) return { kind: 'git', harnessRoot: root, details: {} }
  }
  if (binPath) {
    let start = dirname(binPath)
    try { start = dirname(realpathSync(binPath)) } catch { /* 解析不了就用原路径 */ }
    // 先自内向外找 git 标记(优先级最高:源码 checkout 里 apps/cli 也有同名包,但仓库根在其上方)
    for (let dir = start; ; dir = dirname(dir)) {
      if (isGitCheckout(dir)) return { kind: 'git', harnessRoot: dir, details: {} }
      if (dir === dirname(dir)) break
    }
    const pkgDir = nearestDshPackage(start)
    if (pkgDir) return { kind: 'npm', harnessRoot: pkgDir, details: { packageName: '@deepseek-ai/dsh' } }
  }
  return { kind: 'unknown', harnessRoot: harnessRoot ? resolve(harnessRoot) : null, details: {} }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/detect.test.js`
Expected: 5 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/detect.js test/detect.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: install-shape detection (git/npm/unknown)"
```

---

### Task 4: git 仓检查(fetch + 比对分类)

**Files:**
- Create: `$R/lib/git-check.js`
- Test: `$R/test/git-check.test.js`

**Interfaces:**
- Consumes: `execFile` from `node:child_process`(promisified)。
- Produces: `checkGitRepo({ path, fetch = true, gitBin = 'git' }): Promise<CheckResult>`,其中

```js
// CheckResult(所有模块共用的形状,放 lib/types.js 或 JSDoc typedef)
{
  target: string,        // 仓路径或本体标识
  kind: 'harness-git' | 'harness-npm' | 'integration',   // harness-npm 由 Task 5 引入
  status: 'up-to-date' | 'behind' | 'diverged' | 'no-upstream' | 'error',
  behindCount: number,   // status='behind' 或 'diverged' 时 >0,其余 0;npm 形态远端更新时固定 1
  localRef: string,      // HEAD sha 短值 / 当前版本,取不到为 null
  remoteRef: string,     // upstream sha 短值 / 远端版本,取不到为 null
  error?: string,
}
```

分类规则:`git rev-list --count HEAD..@{upstream}` 与 `@{upstream}..HEAD` 双向计数;`ahead>0 && behind>0` → `diverged`;`behind>0` → `behind`;其余 → `up-to-date`。无 upstream 分支 → `no-upstream`。任何命令非零退出 → `error`(带 stderr 首行,不抛出)。

- [ ] **Step 1: 写失败测试(用真实临时 git 仓,不发网络请求)**

`$R/test/git-check.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkGitRepo } from '../lib/git-check.js'

function sh(repo, ...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}
function commit(repo, file, msg) {
  writeFileSync(join(repo, file), 'x\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg)
}
function cloneWithDivergence() {
  // origin: 1 commit;work: clone + 本地领先 1 + 远端再进 1 → diverged
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-git-'))
  const origin = join(base, 'origin'), work = join(base, 'work')
  mkdirSync(origin)
  sh(origin, 'init', '-b', 'main')
  commit(origin, 'a.txt', 'init')
  sh(work, 'clone', origin, '.')           // clone 自带 origin remote
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local')
  commit(origin, 'b.txt', 'remote advance')
  return { origin, work }
}

test('up-to-date when work matches origin', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-git-'))
  const origin = join(base, 'origin'), work = join(base, 'work')
  mkdirSync(origin); sh(origin, 'init', '-b', 'main')
  commit(origin, 'a.txt', 'init')
  sh(work, 'clone', origin, '.')
  const r = await checkGitRepo({ path: work, fetch: false })
  assert.equal(r.status, 'up-to-date')
  assert.equal(r.behindCount, 0)
})

test('behind when origin advances', async () => {
  const { origin, work } = cloneWithDivergence0()
  // origin 是本地路径,fetch 不走网络;必须 fetch 才能让 work 看到 origin 的新提交
  const r = await checkGitRepo({ path: work, fetch: true })
  assert.equal(r.status, 'behind')
  assert.equal(r.behindCount, 1)
})

test('diverged when both sides advance', async () => {
  const { origin, work } = cloneWithDivergence()
  const r = await checkGitRepo({ path: work, fetch: true })
  assert.equal(r.status, 'diverged')
})

test('error on non-repo path, does not throw', async () => {
  const r = await checkGitRepo({ path: '/nonexistent-repo-xyz', fetch: false })
  assert.equal(r.status, 'error')
  assert.ok(r.error)
})
```

注意:上面 `cloneWithDivergence0`(纯 behind:origin 领先、work 无本地提交)需按 `cloneWithDivergence` 的样子补一个 helper —— clone 后**不**做本地提交,直接让 origin 前进 1 次。两个 helper 都写进测试文件。两个 helper 的 remote 都是本地目录,behind/diverged 用例必须以 `fetch: true` 让 `checkGitRepo` 自己 fetch——不 fetch 的话 work 的 `origin/main` 停在 clone 时刻,永远观察不到 behind/diverged。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/git-check.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/git-check.js`**

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const pExec = promisify(execFile)

async function git(path, args, gitBin) {
  const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 30000 })
  return stdout.trim()
}

export async function checkGitRepo({ path, fetch = true, gitBin = 'git', kind = 'integration' }) {
  const base = { target: path, kind, behindCount: 0, localRef: null, remoteRef: null }
  try {
    if (fetch) await git(path, ['fetch', '--quiet'], gitBin)
  } catch (e) {
    return { ...base, status: 'error', error: String(e.stderr || e.message).split('\n')[0] }
  }
  const counts = async (range) => {
    try { return parseInt(await git(path, ['rev-list', '--count', range], gitBin), 10) }
    catch { return null }
  }
  try {
    const local = await git(path, ['rev-parse', '--short', 'HEAD'], gitBin)
    let upstream
    try { upstream = await git(path, ['rev-parse', '--short', '@{upstream}'], gitBin) }
    catch { return { ...base, localRef: local, status: 'no-upstream' } }
    const behind = await counts(`HEAD..@{upstream}`)
    const ahead = await counts(`@{upstream}..HEAD`)
    if (behind === null || ahead === null) return { ...base, localRef: local, remoteRef: upstream, status: 'error', error: 'rev-list failed' }
    const status = behind > 0 && ahead > 0 ? 'diverged' : behind > 0 ? 'behind' : 'up-to-date'
    return { ...base, localRef: local, remoteRef: upstream, status, behindCount: behind }
  } catch (e) {
    return { ...base, status: 'error', error: String(e.stderr || e.message).split('\n')[0] }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/git-check.test.js`
Expected: 4 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/git-check.js test/git-check.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: git repo check with behind/diverged classification"
```

---

### Task 5: npm dist-tag 检查

**Files:**
- Create: `$R/lib/npm-check.js`
- Test: `$R/test/npm-check.test.js`

**Interfaces:**
- Consumes: Task 2 `isNewer`、Task 4 的 CheckResult 形状。
- Produces: `checkNpmPackage({ packageName = '@deepseek-ai/dsh', currentVersion, distTag = 'latest', npmBin = 'npm' }): Promise<CheckResult>`;npm 形态下 `status`:当前版本解析失败 → `error`;远端版本更新 → `behind`(`behindCount: 1`);否则 `up-to-date`。`npm view <pkg>@<distTag> version` 非零退出 → `error`。

- [ ] **Step 1: 写失败测试(不联网:注入假 npmBin 脚本)**

`$R/test/npm-check.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNpmPackage } from '../lib/npm-check.js'

function fakeNpm(version) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-up-npm-'))
  const bin = join(dir, 'fake-npm')
  writeFileSync(bin, `#!/bin/sh\necho ${version}\n`)
  chmodSync(bin, 0o755)
  return bin
}

test('newer remote → behind', async () => {
  const r = await checkNpmPackage({ currentVersion: '0.1.4', npmBin: fakeNpm('0.2.0') })
  assert.equal(r.status, 'behind')
  assert.equal(r.remoteRef, '0.2.0')
})

test('same version → up-to-date', async () => {
  const r = await checkNpmPackage({ currentVersion: '0.1.5-alpha.1', npmBin: fakeNpm('0.1.5-alpha.1') })
  assert.equal(r.status, 'up-to-date')
})

test('npm failure → error, no throw', async () => {
  const r = await checkNpmPackage({ currentVersion: '1.0.0', npmBin: '/nonexistent-npm-bin' })
  assert.equal(r.status, 'error')
})

test('unparseable current version → error', async () => {
  const r = await checkNpmPackage({ currentVersion: 'garbage', npmBin: fakeNpm('1.0.0') })
  assert.equal(r.status, 'error')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/npm-check.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/npm-check.js`**

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse, isNewer } from './semver.js'

const pExec = promisify(execFile)

export async function checkNpmPackage({ packageName = '@deepseek-ai/dsh', currentVersion, distTag = 'latest', npmBin = 'npm', kind = 'harness-npm' }) {
  const base = { target: packageName, kind, behindCount: 0, localRef: currentVersion ?? null, remoteRef: null }
  if (!parse(currentVersion ?? '')) {
    return { ...base, status: 'error', error: `unparseable current version: ${currentVersion}` }
  }
  let remote
  try {
    const { stdout } = await pExec(npmBin, ['view', `${packageName}@${distTag}`, 'version'], { timeout: 30000 })
    remote = stdout.trim().split('\n').pop()
  } catch (e) {
    return { ...base, status: 'error', error: String(e.stderr || e.message).split('\n')[0] }
  }
  if (!parse(remote)) return { ...base, status: 'error', error: `unparseable remote version: ${remote}` }
  return { ...base, remoteRef: remote, status: isNewer(remote, currentVersion) ? 'behind' : 'up-to-date', behindCount: isNewer(remote, currentVersion) ? 1 : 0 }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/npm-check.test.js`
Expected: 4 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/npm-check.js test/npm-check.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: npm dist-tag check"
```

---

### Task 6: integrations 枚举

**Files:**
- Create: `$R/lib/integrations.js`
- Test: `$R/test/integrations.test.js`

**Interfaces:**
- Consumes: Task 4 `checkGitRepo`。
- Produces: `listIntegrationRepos({ root, fs = { existsSync, readdirSync } }): { path, name }[]}`(只收含 `.git` 的一级子目录);`checkIntegrations({ root, fetch }): Promise<CheckResult[]>`(`kind: 'integration'`;非 git 子目录不产出结果;root 不存在 → 返回 `[]`)。

- [ ] **Step 1: 写失败测试**

`$R/test/integrations.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listIntegrationRepos, checkIntegrations } from '../lib/integrations.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-up-int-'))
  mkdirSync(join(root, 'superpowers', '.git'), { recursive: true })
  mkdirSync(join(root, 'plain'))                       // 非 git → 排除
  mkdirSync(join(root, '.hidden', '.git'), { recursive: true }) // 隐藏目录 → 排除
  return root
}

test('lists only visible first-level dirs containing .git', () => {
  const repos = listIntegrationRepos({ root: fixture() })
  assert.deepEqual(repos.map(r => r.name), ['superpowers'])
})

test('missing root yields empty array, does not throw', async () => {
  assert.deepEqual(await checkIntegrations({ root: '/nonexistent-int-root' }), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/integrations.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/integrations.js`**

```js
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkGitRepo } from './git-check.js'

export function listIntegrationRepos({ root, fs = { existsSync, readdirSync } }) {
  if (!root || !fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .filter(d => fs.existsSync(join(root, d.name, '.git')))
    .map(d => ({ path: join(root, d.name), name: d.name }))
}

export async function checkIntegrations({ root, fetch = true }) {
  const repos = listIntegrationRepos({ root })
  return Promise.all(repos.map(r => checkGitRepo({ path: r.path, fetch, kind: 'integration' })))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/integrations.test.js`
Expected: 2 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/integrations.js test/integrations.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: integrations repo enumeration and check"
```

---

### Task 7: 状态聚合 + 本体检查入口

**Files:**
- Create: `$R/lib/status.js`
- Test: `$R/test/status.test.js`

**Interfaces:**
- Consumes: Task 3 `detectInstallShape`、Task 4 `checkGitRepo`、Task 5 `checkNpmPackage`、Task 6 `checkIntegrations`。
- Produces: `collectStatus({ config, env = { harnessRoot, binPath }, fetch = true }): Promise<{ shape: DetectResult, checks: CheckResult[] }>`。规则:git 形态 → harness 根仓 `checkGitRepo({ kind: 'harness-git' })` + integrations;npm 形态 → 从 `env.harnessRoot/package.json` 读 `version` 作 `currentVersion` 走 `checkNpmPackage` + integrations;`unknown` → `checks: []`。任何单项 error 不影响其他项(Promise.allSettled 语义由各 check 自身不抛保证)。

- [ ] **Step 1: 写失败测试**

`$R/test/status.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectStatus } from '../lib/status.js'

// integrationsDir 指向必不存在的路径:单测不得扫描开发者本机真实的 ~/.dsh/integrations
const CONFIG = { npmDistTag: 'latest', integrationsDir: '/nonexistent-dsh-updater-test-integrations' }

function gitShapeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-up-st-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  return root
}

test('git shape: returns harness-git check + integration checks', async () => {
  const root = gitShapeRoot()
  const s = await collectStatus({ config: CONFIG, env: { harnessRoot: root }, fetch: false })
  assert.equal(s.shape.kind, 'git')
  assert.equal(s.checks[0].kind, 'harness-git')
  assert.equal(s.checks[0].target, root)
})

test('unknown shape: empty checks, no throw', async () => {
  const s = await collectStatus({ config: CONFIG, env: {}, fetch: false })
  assert.equal(s.shape.kind, 'unknown')
  assert.deepEqual(s.checks, [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/status.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/status.js`**

```js
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectInstallShape } from './detect.js'
import { checkGitRepo } from './git-check.js'
import { checkNpmPackage } from './npm-check.js'
import { checkIntegrations } from './integrations.js'

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p
}

export async function collectStatus({ config, env = {}, fetch = true }) {
  const shape = detectInstallShape({ harnessRoot: env.harnessRoot, binPath: env.binPath })
  const checks = []
  if (shape.kind === 'git') {
    checks.push(await checkGitRepo({ path: shape.harnessRoot, fetch, kind: 'harness-git' }))
  } else if (shape.kind === 'npm') {
    let currentVersion = null
    try { currentVersion = JSON.parse(readFileSync(join(shape.harnessRoot, 'package.json'), 'utf8')).version } catch { /* → error path */ }
    checks.push(await checkNpmPackage({ currentVersion, distTag: config.npmDistTag }))
  }
  if (shape.kind !== 'unknown') {
    checks.push(...await checkIntegrations({ root: expandHome(config.integrationsDir), fetch }))
  }
  return { shape, checks }
}
```

- [ ] **Step 4: 跑全部测试确认通过**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 此前所有测试仍 PASS + 新增 2 个 PASS

- [ ] **Step 5: 提交**

```bash
git -C /Users/dmall/Projects/dsh-updater add lib/status.js test/status.test.js
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: status aggregation across shape and integrations"
```

---

### Task 8: Schemastery Config + dsh_update_status 工具 + checkOnStart

**Files:**
- Modify: `$R/index.js`(整体替换)
- Create: `$R/lib/tool.js`
- Modify: `$R/test/smoke.test.js`(fake ctx 补 `effect` 与 `tools` stub——Task 8 的 apply 会调 `ctx.effect` 与 `ctx.tools.register`,Task 1 的 fake ctx 只有 logger,直接跑会 TypeError)
- Test: `$R/test/tool.test.js`
- Keep: `$R/cordis.patch.yml`(`config:` 段保留——不迁 schemastery 的理由见 Global Constraints)

**Interfaces:**
- Consumes: Task 7 `collectStatus`;Task 3 探测所需 `env` 的来源:**当前运行中 dsh 的入口路径** `realpathSync(process.argv[1])`(源码形态 argv[1] 落在 harness 仓内,npm 形态落在 `@deepseek-ai/dsh` 包内,再交 Task 3 的 walk-up 判定)。**不要用插件自身 `import.meta.url`**——`link:` 安装下插件被 symlink 进 profile,其真实路径是本插件仓,walk-up 永远到不了 harness(2026-09-10 修订,依据 publish 指南与本机 `~/.dsh/profiles/web/node_modules/` 实况)。
- 工具契约(已对照 `@deepseek-ai/dsh-tools` 的 `ToolRuntime.register` 与 cordis-host-runner 沙箱 guard 确认):裸 `ctx.tools.register()` **必须声明 `output: { schema, render }`**,否则注册抛 TypeError;`execute` 签名是 **`execute(args, exec)`**,第一参数是模型入参。
- Produces: 工具 `dsh_update_status`,输入 schema `{ detail?: boolean }`;output schema `{ type: 'string' }`,execute 返回 JSON 文本:`{ shape, summary: {upToDate, behind, diverged, error, noUpstream}, checks }`(`detail=false` 时 `checks` 只留 target/kind/status/behindCount/error,保留 error 便于压缩视图下仍可诊断)。

- [ ] **Step 1: 写失败测试(注入 fake collectStatus,验证工具输出裁剪)**

`$R/test/tool.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStatusTool } from '../lib/tool.js'

const FAKE = {
  shape: { kind: 'git', harnessRoot: '/x' },
  checks: [
    { target: '/x', kind: 'harness-git', status: 'behind', behindCount: 3, localRef: 'aaa', remoteRef: 'bbb' },
    { target: '/i/sp', kind: 'integration', status: 'up-to-date', behindCount: 0, localRef: 'ccc', remoteRef: 'ccc' },
  ],
}

test('summary counts aggregate statuses', async () => {
  const tool = createStatusTool({ collectStatus: async () => FAKE })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.deepEqual(out.summary, { upToDate: 1, behind: 1, diverged: 0, error: 0, noUpstream: 0 })
})

test('detail=false strips refs from checks', async () => {
  const tool = createStatusTool({ collectStatus: async () => FAKE })
  // 真实签名 execute(args, exec):第一参数才是模型入参
  const out = JSON.parse(await tool.execute({ detail: false }, {}))
  assert.equal(out.checks[0].localRef, undefined)
  assert.equal(out.checks[0].behindCount, 3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/tool.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `$R/lib/tool.js`**

```js
export function createStatusTool({ collectStatus }) {
  return {
    name: 'dsh_update_status',
    description: 'Show dsh updater status: install shape, harness and integration repos vs upstream.',
    parameters: {
      type: 'object',
      properties: { detail: { type: 'boolean', description: 'Include commit refs in per-repo results.' } },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, _exec) {
      const { detail = true } = args ?? {}
      const { shape, checks } = await collectStatus({})
      const KEYS = { 'up-to-date': 'upToDate', behind: 'behind', diverged: 'diverged', error: 'error', 'no-upstream': 'noUpstream' }
      const summary = { upToDate: 0, behind: 0, diverged: 0, error: 0, noUpstream: 0 }
      for (const c of checks) summary[KEYS[c.status] ?? 'error']++
      return JSON.stringify({
        shape,
        summary,
        checks: detail ? checks : checks.map(({ localRef, remoteRef, ...rest }) => rest),
      }, null, 2)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test /Users/dmall/Projects/dsh-updater/test/tool.test.js`
Expected: 2 个 PASS

- [ ] **Step 5: 写 Schemastery Config 并装配 index.js**

`$R/index.js` 整体替换为:

```js
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectStatus } from './lib/status.js'
import { createStatusTool } from './lib/tool.js'

export const name = 'dsh-updater'
// 工具注册要等 tools 服务就绪(与 harness 全部插件一致的要求)
export const inject = ['tools']

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
  // 不用插件自身 import.meta.url:link: 安装下其真实路径是本插件仓,walk-up 永远到不了 harness。
  try { return realpathSync(process.argv[1]) } catch { return fileURLToPath(import.meta.url) }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config }
  const binPath = dshBinPath()
  ctx.logger?.info?.('dsh-updater loaded, checkOnStart=%s', cfg.checkOnStart)
  const runStatus = () => collectStatus({ config: cfg, env: { binPath }, fetch: true })
    .then(({ shape, checks }) => {
      const problems = checks.filter(c => c.status === 'behind' || c.status === 'diverged' || c.status === 'error')
      if (problems.length) ctx.logger?.info?.('dsh-updater: %d update-relevant results (shape=%s)', problems.length, shape.kind)
    })
    .catch(e => ctx.logger?.warn?.('dsh-updater check failed: %s', e?.message ?? e))

  if (cfg.checkOnStart) void runStatus()

  const timer = setInterval(() => void runStatus(), cfg.checkIntervalMinutes * 60_000)
  timer.unref?.()
  // timer 是 cordis 不管理的资源,按教程用 ctx.effect 包一层,卸载时执行 disposer
  ctx.effect(() => () => clearInterval(timer))

  ctx.tools.register(createStatusTool({
    collectStatus: (opts = {}) => collectStatus({ ...opts, config: cfg, env: { binPath } }),
  }))
}
```

`$R/cordis.patch.yml` **不需要改动**:`config:` 段保留——config 默认值由 patch 行下发(spec §7 原意),代码侧 `DEFAULTS` 仅作 patch 缺失时的兜底。

timer 清理已直接采用 `ctx.effect(() => () => clearInterval(timer))`(cordis 教程对 timer 类资源的既定做法;`ctx.on('dispose')` 在整个 harness 无使用者,不要采用)。

同步修改 `$R/test/smoke.test.js` 第二个用例的 fake ctx:从 `{ logger: { info: (m) => logs.push(m) } }` 扩为 `{ logger: { info: (m) => logs.push(m) }, effect: (fn) => fn(), tools: { register: () => () => {} } }`;两条断言保持不变(新 apply 仍在入口打 `dsh-updater loaded` 日志)。

- [ ] **Step 6: 全量测试 + 提交**

Run: `node --test --test-reporter=spec /Users/dmall/Projects/dsh-updater/test/*.test.js`
Expected: 全部 PASS(index.js 只 import node 内建与本地模块,`node --test` 可直接 import,无外部依赖解析问题)

```bash
git -C /Users/dmall/Projects/dsh-updater add index.js cordis.patch.yml lib/tool.js test/tool.test.js test/smoke.test.js package.json
git -C /Users/dmall/Projects/dsh-updater commit -m "feat: dsh_update_status tool, periodic check, argv-derived shape detection"
```

- [ ] **Step 7: 本机真机验收(git 形态只读端到端)**

```bash
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh plugin --profile web add /Users/dmall/Projects/dsh-updater
pnpm --dir /Users/dmall/Projects/deepseek-harness dsh --profile web --dump-config 2>/dev/null | grep -c "dsh-updater"
```

然后由用户重启 web profile,在新会话里让 agent 调 `dsh_update_status`,确认:shape=git、harness-git 一条(superpowers 若在 `~/.dsh/integrations` 下则再一条),status 合理(本仓上游在 GitHub,fetch 可达时应为 behind 或 up-to-date)。

---

## Self-Review 记录

(2026-09-10 按对照 harness 源码的 review 修订,详见下方修订记录)

- **Spec 覆盖**:M1 对应 spec §8 里程碑 1;§2 形态探测 → Task 3/7/8(bin 路径取 `process.argv[1]`,即 spec §2「bin 路径回溯」原意);§3 integrations → Task 6/7;§5 `dsh_update_status` → Task 8(补 harness 强制的 `output` 声明与 `execute(args, exec)` 签名);§7 config 字段 → Task 1(patch 行下发,即 spec §7 原文形态);§9 测试要点 → Task 3(fake 目录)/4/5(假 npmBin)/6。§4/§6 的更新与回滚属 M2/M3,不在本计划。
- **占位符**:无 TBD;Task 4 Step 1 对缺失的 `cloneWithDivergence0` helper 给出了明确构造说明(非 "similar to")。
- **类型一致**:`CheckResult` 形状在 Task 4 定义(`kind` 含 Task 5 的 `harness-npm`;`behindCount` 在 diverged 时亦 >0,与 Task 4/5 实现一致),Task 5/6/7 沿用同名字段;`collectStatus` 签名在 Task 7 定义、Task 8 消费一致;`isNewer`/`compareVersions` 在 Task 2 定义、Task 5 使用一致。

## 修订记录(2026-09-10,依据对照 harness 源码与本机实况的 review)

1. **形态探测输入改为 `process.argv[1]`**(Task 3 walk-up 逻辑扩展、Task 8 env 来源):`dsh plugin add <本地路径>` 是 pnpm `link:` 符号链接安装,插件自身 `import.meta.url` 解析回本插件仓,walk-up 永远到不了 harness,原方案恒为 `unknown`。证据:publish.md 的 `link:` 语义、本机 `~/.dsh/profiles/web/node_modules/` 全部为指向 `~/Projects/*` 的 symlink。
2. **walk-up 时 git 标记优先于 npm 包名**(Task 3):源码 checkout 的 `apps/cli/package.json` 同名 `@deepseek-ai/dsh`,但仓库根在其上方,自内向外必须 git 先胜出。
3. **`dsh_update_status` 补 `output: { schema, render }` 并改为 `execute(args, exec)`**(Task 8):`ToolRuntime.register()` 对缺 `output` 的裸注册抛 TypeError;第一参数是模型入参——原 `(ctx, args)` 假设会让 `detail` 在真机上静默恒为 true(单测因模仿同一错误约定仍绿)。
4. **index.js 补 `inject = ['tools']`,timer 清理改 `ctx.effect`**(Task 8):工具注册必须等 tools 服务就绪;`ctx.on('dispose')` 在整个 harness 无使用者。
5. **config 默认值留在 patch 行、不引入 schemastery**(Global Constraints / Task 1 / Task 8):`@deepseek-ai/schemastery` 是 harness 内 vendor 的 `link:` 包,对独立 link 安装仓不可靠解析;spec §7 原文形态即 patch 下发。
6. **Task 4 测试两处修正**:补 `writeFileSync`/`mkdirSync` import(否则 ReferenceError);behind/diverged 用例改 `fetch: true`(remote 是本地路径不走网络)——不 fetch 则 `origin/main` 停在 clone 时刻,behind/diverged 永远观察不到。
7. **Task 7 单测不再扫描真实 `~/.dsh/integrations`**:`integrationsDir` 指向必不存在路径。
8. **`integrationsGlob` → `integrationsDir`**(与 spec §7 同步):实现只支持「单目录一级子目录」语义,glob 命名误导。
9. **CheckResult 契约收紧**(Task 4):`kind` 联合补 `harness-npm`;`behindCount` 在 diverged 时亦 >0(与实现一致);`detail=false` 压缩视图保留 `error` 字段。
