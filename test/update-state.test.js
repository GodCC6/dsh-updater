import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateState } from '../lib/update-state.js'

test('snapshot exposes pendingRestart:false initially', () => {
  const s = createUpdateState()
  assert.equal(s.snapshot().pendingRestart, false)
})

test('notePendingRestart flips the flag; clearPendingRestart resets it', () => {
  const s = createUpdateState()
  s.notePendingRestart()
  assert.equal(s.snapshot().pendingRestart, true)
  s.clearPendingRestart()
  assert.equal(s.snapshot().pendingRestart, false)
})

test('begin does not clear a standing pendingRestart (restart is cross-run)', () => {
  const s = createUpdateState()
  s.notePendingRestart()
  assert.equal(s.begin(), true)
  assert.equal(s.snapshot().pendingRestart, true) // 未重启前一直提示
})

// M2 既有语义回归(补测,防 M4 改动回退)
test('begin/finish gate still works', () => {
  const s = createUpdateState()
  assert.equal(s.begin(), true)
  assert.equal(s.begin(), false)
  s.finish({ ok: true })
  assert.ok(s.snapshot().lastResult.finishedAt > 0)
  assert.equal(s.begin(), true)
})

test('abort before begin is a no-op (no controller yet)', () => {
  const s = createUpdateState()
  assert.doesNotThrow(() => s.abort('x'))
  assert.equal(s.signal, undefined)
})
