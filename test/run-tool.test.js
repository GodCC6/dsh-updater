import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunTool } from '../lib/run-tool.js'

const SHAPE_GIT = { kind: 'git', harnessRoot: '/harness' }

function fakeCollect({ shape = SHAPE_GIT, harnessStatus = 'behind', ints = [] } = {}) {
  const checks = []
  if (harnessStatus) checks.push({ target: '/harness', kind: 'harness-git', status: harnessStatus, behindCount: harnessStatus === 'behind' ? 3 : 0 })
  for (const [name, status] of ints) checks.push({ target: `/ints/${name}`, kind: 'integration', status, behindCount: status === 'behind' ? 1 : 0 })
  return async () => ({ shape, checks })
}

test('behind harness starts update with jobId', async () => {
  const tool = createRunTool({ collectStatus: fakeCollect({}), startUpdate: async () => ({ jobId: 'dsh-update-1' }) })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, true)
  assert.equal(out.jobId, 'dsh-update-1')
  assert.deepEqual(out.plan, [{ target: 'harness', path: '/harness', behind: 3 }])
  assert.match(out.note, /restart/i)
})

test('nothing behind → refuse without starting', async () => {
  let called = false
  const tool = createRunTool({
    collectStatus: fakeCollect({ harnessStatus: 'up-to-date' }),
    startUpdate: async () => { called = true; return { jobId: 'x' } },
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, false)
  assert.match(out.reason, /nothing to update/)
  assert.equal(called, false)
})

test('diverged harness is skipped with reason; behind integrations still planned', async () => {
  const tool = createRunTool({
    collectStatus: fakeCollect({ harnessStatus: 'diverged', ints: [['sp', 'behind']] }),
    startUpdate: async () => ({ jobId: 'j1' }),
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, true)
  assert.deepEqual(out.plan, [{ target: '/ints/sp', behind: 1 }])
  assert.match(out.skipped[0].reason, /diverged/)
})

test('non-git shape → refused (npm form is M3)', async () => {
  const tool = createRunTool({
    collectStatus: fakeCollect({ shape: { kind: 'unknown' }, harnessStatus: null }),
    startUpdate: async () => ({ jobId: 'x' }),
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, false)
  assert.match(out.reason, /unsupported install shape/)
})

test('startUpdate throw → started:false with reason', async () => {
  const tool = createRunTool({
    collectStatus: fakeCollect({}),
    startUpdate: async () => { throw new Error('an update is already running') },
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.started, false)
  assert.match(out.reason, /already running/)
})
