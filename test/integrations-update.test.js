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
  const origins = mkdtempSync(join(tmpdir(), 'dsh-up-iu-o-')) // origin 是 remote,放在 integrations root 之外
  for (const name of ['repo-a', 'repo-b']) {
    const origin = join(origins, `${name}-origin`), work = join(root, name)
    mkdirSync(origin); mkdirSync(work)
    sh(origin, 'init', '-b', 'main')
    commit(origin, 'a.txt', 'init')
    sh(work, 'clone', origin, '.')
  }
  commit(join(origins, 'repo-a-origin'), 'b.txt', 'remote advance') // repo-a 落后
  mkdirSync(join(root, 'plain'))
  return { root, originA: join(origins, 'repo-a-origin') }
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
