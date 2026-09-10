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
  commit(origin, 'b.txt', 'remote advance')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local') // 本地新增 local 提交 → diverged
  const before = head(work)
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
