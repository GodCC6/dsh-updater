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
function cloneWithDivergence0() {
  // 纯 behind:origin: 1 commit;work: clone 后无本地提交,origin 再进 1 → behind
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-git-'))
  const origin = join(base, 'origin'), work = join(base, 'work')
  mkdirSync(origin); mkdirSync(work)       // git -C 要求目录已存在
  sh(origin, 'init', '-b', 'main')
  commit(origin, 'a.txt', 'init')
  sh(work, 'clone', origin, '.')           // clone 自带 origin remote
  commit(origin, 'b.txt', 'remote advance')
  return { origin, work }
}
function cloneWithDivergence() {
  // origin: 1 commit;work: clone + 本地领先 1 + 远端再进 1 → diverged
  const base = mkdtempSync(join(tmpdir(), 'dsh-up-git-'))
  const origin = join(base, 'origin'), work = join(base, 'work')
  mkdirSync(origin); mkdirSync(work)       // git -C 要求目录已存在
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
  mkdirSync(origin); mkdirSync(work); sh(origin, 'init', '-b', 'main')
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
