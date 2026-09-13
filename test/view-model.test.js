import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toViewModel } from '../client.js'

const base = (update = {}) => ({ shape: { kind: 'git' }, summary: {}, checks: [], update: { running: false, pendingRestart: false, lastResult: null, ...update } })

test('all up-to-date renders ok pills, update enabled, no banner', () => {
  const vm = toViewModel(base({ lastResult: null, checks: [] }))
  assert.deepEqual(vm.pills, [])
  assert.equal(vm.canUpdate, false)
  assert.equal(vm.canCancel, false)
  assert.equal(vm.banner, undefined)
})

test('behind harness pill and enabled actions', () => {
  const s = base()
  s.checks = [{ kind: 'harness-git', target: '/h', status: 'behind', behindCount: 7 }]
  const vm = toViewModel(s)
  assert.equal(vm.pills[0].tone, 'behind')
  assert.match(vm.pills[0].detail, /behind 7/)
  assert.equal(vm.canUpdate, true)
  assert.equal(vm.canCancel, false)
})

test('diverged integration renders diverged tone, update still allowed for others', () => {
  const s = base()
  s.checks = [
    { kind: 'harness-git', target: '/h', status: 'up-to-date' },
    { kind: 'integration', target: '/i', status: 'diverged' },
  ]
  const vm = toViewModel(s)
  assert.equal(vm.pills[1].tone, 'diverged')
  assert.equal(vm.canUpdate, true)
})

test('error check renders error tone', () => {
  const s = base()
  s.checks = [{ kind: 'harness-git', target: '/h', status: 'error', error: 'boom' }]
  const vm = toViewModel(s)
  assert.equal(vm.pills[0].tone, 'error')
})

test('running snapshot disables update, enables cancel, exposes steps', () => {
  const s = base({ running: true })
  const vm = toViewModel(s)
  assert.equal(vm.running, true)
  assert.equal(vm.canUpdate, false)
  assert.equal(vm.canCancel, true)
})

test('pendingRestart sets banner even after lastResult success', () => {
  const s = base({ pendingRestart: true, lastResult: { ok: true } })
  const vm = toViewModel(s)
  assert.match(vm.banner, /restart/i)
})

test('failed lastResult surfaces steps and reason', () => {
  const s = base({ lastResult: { ok: false, harness: { ok: false, steps: [{ step: 'install', status: 'failed' }] } } })
  const vm = toViewModel(s)
  assert.equal(vm.lastReason, 'failed')
  assert.deepEqual(vm.steps, [{ step: 'install', status: 'failed' }])
})
