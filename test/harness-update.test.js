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
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local') // 本地新增 local 提交 → diverged
  const { bin, log } = fakePnpm()
  commit(origin, 'b.txt', 'remote advance')
  const r = await runHarnessUpdate({ path: work, pnpmBin: bin })
  assert.equal(r.ok, false)
  assert.equal(r.rolledBack, false)
  assert.deepEqual(pnpmCalls(log), [])
  assert.equal(r.steps[0].step, 'pull')
  assert.equal(r.steps[0].status, 'diverged')
})
