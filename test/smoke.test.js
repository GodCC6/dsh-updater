import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, apply, inject } from '../index.js'
import { gatedCtx } from './helpers/gated-ctx.js'

test('plugin exports name and apply', () => {
  assert.equal(name, 'dsh-updater')
  assert.equal(typeof apply, 'function')
})

test('apply logs and does not throw', () => {
  const { ctx, logs } = gatedCtx(inject)
  apply(ctx, { checkOnStart: true })
  assert.match(logs[0], /dsh-updater loaded/)
})
