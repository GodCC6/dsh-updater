import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan } from '../lib/update-plan.js'

test('non-git shape refuses (npm lands in M3)', () => {
  const r = buildPlan({ shape: { kind: 'npm' }, checks: [] })
  assert.equal(r.refusal.reason, 'unsupported install shape: npm (npm form lands in M3)')
  assert.equal(r.plan.length, 0)
})

test('harness behind lands in plan with path and behind count', () => {
  const r = buildPlan({ shape: { kind: 'git' }, checks: [
    { kind: 'harness-git', target: '/h', status: 'behind', behindCount: 5 },
  ] })
  assert.deepEqual(r.plan, [{ target: 'harness', path: '/h', behind: 5 }])
  assert.equal(r.refusal, undefined)
})

test('up-to-date harness is skipped, diverged integration reports manual action', () => {
  const r = buildPlan({ shape: { kind: 'git' }, checks: [
    { kind: 'harness-git', target: '/h', status: 'up-to-date' },
    { kind: 'integration', target: '/i1', status: 'behind', behindCount: 2 },
    { kind: 'integration', target: '/i2', status: 'diverged' },
  ] })
  assert.deepEqual(r.plan, [{ target: '/i1', behind: 2 }])
  assert.deepEqual(r.skipped, [
    { target: '/h', reason: 'harness status up-to-date' },
    { target: '/i2', reason: 'diverged: manual action required' },
  ])
})

test('empty plan refuses with nothing to update', () => {
  const r = buildPlan({ shape: { kind: 'git' }, checks: [
    { kind: 'harness-git', target: '/h', status: 'up-to-date' },
  ] })
  assert.equal(r.refusal.reason, 'nothing to update')
})
