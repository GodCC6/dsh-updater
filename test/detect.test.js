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
