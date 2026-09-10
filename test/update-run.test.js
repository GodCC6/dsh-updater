import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateState } from '../lib/update-state.js'
import { runUpdatePipeline } from '../lib/update-run.js'

const OK_HARNESS = { ok: true, rolledBack: false, cancelled: false, fromSha: 'a', toSha: 'b', steps: [] }

test('happy path: stages recorded, finish summary ok', async () => {
  const state = createUpdateState()
  assert.equal(state.begin(), true)
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => {
      state.stage({ target: '/harness', step: 'pull', status: 'ok' })
      return OK_HARNESS
    },
    runIntegrationsUpdateImpl: async () => [],
  })
  assert.equal(summary.ok, true)
  assert.equal(summary.cancelled, false)
  assert.equal(state.snapshot().running, false)
  assert.ok(state.snapshot().log.some(e => e.step === 'pull'))
  assert.ok(state.snapshot().lastResult.finishedAt > 0)
})

test('begin refuses concurrent run; finish re-opens', async () => {
  const state = createUpdateState()
  assert.equal(state.begin(), true)
  assert.equal(state.begin(), false)
  state.finish({ ok: true })
  assert.equal(state.begin(), true)
})

test('harness failure → ok:false, integrations still run', async () => {
  const state = createUpdateState()
  state.begin()
  let intsRan = false
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => ({ ok: false, rolledBack: true, cancelled: false, fromSha: 'a', toSha: 'a', steps: [] }),
    runIntegrationsUpdateImpl: async () => { intsRan = true; return [{ name: 'x', status: 'updated' }] },
  })
  assert.equal(summary.ok, false)
  assert.equal(intsRan, true)
  assert.equal(summary.integrations[0].status, 'updated')
})

test('cancel marker from harness → summary.cancelled, integrations skipped', async () => {
  const state = createUpdateState()
  state.begin()
  const err = new Error('update cancelled'); err.cancelled = true
  let intsRan = false
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => { throw err },
    runIntegrationsUpdateImpl: async () => { intsRan = true; return [] },
  })
  assert.equal(summary.cancelled, true)
  assert.equal(summary.ok, false)
  assert.equal(intsRan, false)
  assert.equal(state.snapshot().running, false)
})

test('harnessPath null → integrations only', async () => {
  const state = createUpdateState()
  state.begin()
  let harnessRan = false
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: null,
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => { harnessRan = true; return OK_HARNESS },
    runIntegrationsUpdateImpl: async () => [],
  })
  assert.equal(harnessRan, false)
  assert.equal(summary.harness, null)
  assert.equal(summary.ok, true)
})

test('unexpected exception from harness → ok:false, gate released, error staged', async () => {
  const state = createUpdateState()
  state.begin()
  const summary = await runUpdatePipeline({
    updateState: state,
    harnessPath: '/harness',
    integrationsRoot: '/ints',
    runHarnessUpdateImpl: async () => { throw new Error('boom') },
    runIntegrationsUpdateImpl: async () => [],
  })
  assert.equal(summary.ok, false)
  assert.equal(summary.cancelled, false)
  assert.equal(state.snapshot().running, false)
  assert.ok(state.snapshot().log.some(e => e.step === 'error' && e.status === 'failed'))
})

test('abort() flips the signal the pipeline sees', async () => {
  const state = createUpdateState()
  state.begin()
  assert.equal(state.signal.aborted, false)
  state.abort('test')
  assert.equal(state.signal.aborted, true)
  state.finish({ ok: false, cancelled: true })
})
