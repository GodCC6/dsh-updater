import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStatusTool } from '../lib/tool.js'

const FAKE = {
  shape: { kind: 'git', harnessRoot: '/x' },
  checks: [
    { target: '/x', kind: 'harness-git', status: 'behind', behindCount: 3, localRef: 'aaa', remoteRef: 'bbb' },
    { target: '/i/sp', kind: 'integration', status: 'up-to-date', behindCount: 0, localRef: 'ccc', remoteRef: 'ccc' },
  ],
}

test('summary counts aggregate statuses', async () => {
  const tool = createStatusTool({ collectStatus: async () => FAKE })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.deepEqual(out.summary, { upToDate: 1, behind: 1, diverged: 0, error: 0, noUpstream: 0 })
})

test('detail=false strips refs from checks', async () => {
  const tool = createStatusTool({ collectStatus: async () => FAKE })
  // 真实签名 execute(args, exec):第一参数才是模型入参
  const out = JSON.parse(await tool.execute({ detail: false }, {}))
  assert.equal(out.checks[0].localRef, undefined)
  assert.equal(out.checks[0].behindCount, 3)
})

test('collectStatus rejection yields error JSON, never rejects', async () => {
  const tool = createStatusTool({ collectStatus: async () => { throw new Error('boom') } })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.shape, null)
  assert.match(out.error, /boom/)
})

test('extra collectStatus fields (update snapshot) pass through', async () => {
  const tool = createStatusTool({ collectStatus: async () => ({ ...FAKE, update: { running: true, log: [{ at: 1, target: '/x', step: 'pull', status: 'ok' }] } }) })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.update.running, true)
  assert.equal(out.update.log[0].step, 'pull')
})
