import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCancelTool } from '../lib/cancel-tool.js'

test('no running update → cancelled:false with reason, abort not called', async () => {
  let aborted = false
  const tool = createCancelTool({
    getSnapshot: () => ({ running: false, log: [], lastResult: null }),
    abort: () => { aborted = true },
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.cancelled, false)
  assert.match(out.reason, /no update in progress/)
  assert.equal(aborted, false)
})

test('running update → abort called with reason, cancelled:true', async () => {
  const calls = []
  const tool = createCancelTool({
    getSnapshot: () => ({ running: true, log: [], lastResult: null }),
    abort: (r) => calls.push(r),
  })
  const out = JSON.parse(await tool.execute({}, {}))
  assert.equal(out.cancelled, true)
  assert.deepEqual(calls, ['cancelled by user'])
  assert.match(out.note, /roll back/i)
})

test('tool shape: name, output.schema, render present', () => {
  const tool = createCancelTool({ getSnapshot: () => ({ running: false }), abort: () => {} })
  assert.equal(tool.name, 'dsh_update_cancel')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
})
