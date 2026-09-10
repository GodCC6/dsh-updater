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
