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
