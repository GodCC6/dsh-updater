import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, apply } from '../index.js'

test('plugin exports name and apply', () => {
  assert.equal(name, 'dsh-updater')
  assert.equal(typeof apply, 'function')
})

test('apply logs and does not throw', () => {
  const logs = []
  apply({ logger: { info: (m) => logs.push(m) }, effect: (fn) => fn(), tools: { register: () => () => {} } }, { checkOnStart: true })
  assert.match(logs[0], /dsh-updater loaded/)
})
