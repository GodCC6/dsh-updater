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
