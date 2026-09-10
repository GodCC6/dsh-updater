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
