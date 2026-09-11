import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

test('first-level dir without .git falls back to nested repo/ git dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-up-int-'))
  mkdirSync(join(root, 'superpowers', 'repo', '.git'), { recursive: true }) // 真实布局: superpowers/repo/
  mkdirSync(join(root, 'plain', 'repo'), { recursive: true })               // repo 存在但非 git → 排除
  const repos = listIntegrationRepos({ root })
  assert.deepEqual(repos, [{ path: join(root, 'superpowers', 'repo'), name: 'superpowers' }])
})

test('direct .git wins over nested repo/ when both exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-up-int-'))
  mkdirSync(join(root, 'dual', '.git'), { recursive: true })
  mkdirSync(join(root, 'dual', 'repo', '.git'), { recursive: true })
  const repos = listIntegrationRepos({ root })
  assert.deepEqual(repos, [{ path: join(root, 'dual'), name: 'dual' }])
})

test('missing root yields empty array, does not throw', async () => {
  assert.deepEqual(await checkIntegrations({ root: '/nonexistent-int-root' }), [])
})

test('root that is a regular file yields empty array, does not reject', async () => {
  const fileRoot = join(mkdtempSync(join(tmpdir(), 'dsh-up-int-')), 'not-a-dir')
  writeFileSync(fileRoot, 'plain file') // existsSync=true,但 readdirSync 抛 ENOTDIR
  await assert.doesNotReject(() => checkIntegrations({ root: fileRoot }))
  assert.deepEqual(await checkIntegrations({ root: fileRoot }), [])
})
