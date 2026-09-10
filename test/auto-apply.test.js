import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutoApplier } from '../lib/auto-apply.js'

const GIT = { kind: 'git', harnessRoot: '/harness' }

function harnessCheck(status, remoteRef = 'r1', behindCount = status === 'behind' ? 3 : 0) {
  return { target: '/harness', kind: 'harness-git', status, behindCount, remoteRef }
}
function intCheck(name, status, remoteRef = 'i1') {
  return { target: `/ints/${name}`, kind: 'integration', status, behindCount: status === 'behind' ? 1 : 0, remoteRef }
}
// 简易 attempted 存储
function attemptedStore(init = []) {
  const m = new Map(init)
  return { getAttempted: () => m, markAttempted: (t, r) => m.set(t, r), _m: m }
}

test('behind harness + idle → starts update, plan matches M2 shape, marked before start', async () => {
  const store = attemptedStore()
  let markedBeforeStart = false
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind', 'rNEW')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted,
    markAttempted: store.markAttempted,
    startUpdate: async () => { markedBeforeStart = store._m.get('/harness') === 'rNEW'; return { jobId: 'dsh-update-9' } },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, true)
  assert.equal(r.jobId, 'dsh-update-9')
  assert.deepEqual(r.plan, [{ target: 'harness', path: '/harness', behind: 3 }])
  assert.equal(markedBeforeStart, true)
})

test('behind but not idle → does not start', async () => {
  let started = false
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind')] }),
    isIdle: () => false,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { started = true; return { jobId: 'x' } },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /not idle/)
  assert.equal(started, false)
})

test('non-git shape → refused', async () => {
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: { kind: 'unknown' }, checks: [] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => ({ jobId: 'x' }),
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /not git/)
})

test('diverged harness is never planned', async () => {
  const store = attemptedStore()
  let started = false
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('diverged')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { started = true; return { jobId: 'x' } },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /nothing new/)
  assert.equal(started, false)
})

test('already-attempted same remoteRef is skipped; new remoteRef retries', async () => {
  const store = attemptedStore([['/harness', 'rOLD']])
  let starts = 0
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind', 'rOLD')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { starts++; return { jobId: 'x' } },
  })
  const r1 = await applier.maybeAutoApply()
  assert.equal(r1.started, false)          // 同 remoteRef 已试过 → 跳过
  assert.match(r1.reason, /nothing new/)

  // 上游再进:remoteRef 变化 → 应重试
  const applier2 = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind', 'rNEWER')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { starts++; return { jobId: 'x' } },
  })
  const r2 = await applier2.maybeAutoApply()
  assert.equal(r2.started, true)
  assert.equal(starts, 1)
})

test('mixed: behind harness + behind int + up-to-date int + diverged int → plan has only the two behind', async () => {
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [
      harnessCheck('behind', 'rH'),
      intCheck('sp', 'behind', 'rSP'),
      intCheck('up', 'up-to-date'),
      intCheck('dv', 'diverged'),
    ] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async (plan) => ({ jobId: 'x', _plan: plan }),
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, true)
  assert.deepEqual(r.plan, [
    { target: 'harness', path: '/harness', behind: 3 },
    { target: '/ints/sp', behind: 1 },
  ])
})

test('startUpdate throwing (already running) → started:false with reason', async () => {
  const store = attemptedStore()
  const applier = createAutoApplier({
    collectStatus: async () => ({ shape: GIT, checks: [harnessCheck('behind')] }),
    isIdle: () => true,
    getAttempted: store.getAttempted, markAttempted: store.markAttempted,
    startUpdate: async () => { throw new Error('an update is already running') },
  })
  const r = await applier.maybeAutoApply()
  assert.equal(r.started, false)
  assert.match(r.reason, /already running/)
})
