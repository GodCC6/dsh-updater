import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClientRpc } from '../lib/client-rpc.js'

const SNAPSHOT = { shape: { kind: 'git' }, summary: {}, checks: [], update: { running: false } }

function rpc({ collect = async () => SNAPSHOT, startUpdate = async () => ({ jobId: 'j1' }), snapshot = { running: false }, abort = () => {} } = {}) {
  return createClientRpc({ collect, startUpdate, getSnapshot: () => snapshot, abort })
}

test('get-status returns the collect snapshot', async () => {
  const r = await rpc().dispatch('get-status')
  assert.equal(r.ok, true)
  assert.equal(r.value.update.running, false)
})

test('get-status passes fetch opt to collect: false while running, true when idle', async () => {
  // 运行中轮询降级为不 fetch 的快照读取,避免 5s 快轮的 git fetch 与 pipeline 的
  // git pull 竞态;空闲时保持 fetch:true。断言 collect 收到的精确 opts 对象。
  const snapshot = { running: false }
  const seen = []
  const collect = async (opts) => { seen.push(opts); return SNAPSHOT }
  const r1 = await rpc({ collect, snapshot }).dispatch('get-status')
  assert.equal(r1.ok, true)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen.at(-1), { fetch: true })
  snapshot.running = true
  const r2 = await rpc({ collect, snapshot }).dispatch('get-status')
  assert.equal(r2.ok, true)
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.at(-1), { fetch: false })
})

test('start-update behind → started with jobId and plan', async () => {
  const collect = async () => ({ ...SNAPSHOT, checks: [{ kind: 'harness-git', target: '/h', status: 'behind', behindCount: 3 }] })
  const r = await rpc({ collect }).dispatch('start-update')
  assert.equal(r.value.started, true)
  assert.equal(r.value.jobId, 'j1')
  assert.deepEqual(r.value.plan, [{ target: 'harness', path: '/h', behind: 3 }])
})

test('start-update nothing to update → refusal as value with skipped', async () => {
  const r = await rpc().dispatch('start-update')
  assert.equal(r.value.started, false)
  assert.equal(r.value.reason, 'nothing to update')
})

test('start-update startUpdate throw → started:false with reason', async () => {
  // buildPlan 会在空 plan 时先行 refusal,故这里给 behind 检查让流程真正走到 startUpdate
  const collect = async () => ({ ...SNAPSHOT, checks: [{ kind: 'harness-git', target: '/h', status: 'behind', behindCount: 3 }] })
  const r = await rpc({ collect, startUpdate: async () => { throw new Error('an update is already running') } }).dispatch('start-update')
  assert.equal(r.value.started, false)
  assert.equal(r.value.reason, 'an update is already running')
})

test('cancel when idle → cancelled:false with reason, abort not called', async () => {
  let called = false
  const r = await rpc({ abort: () => { called = true } }).dispatch('cancel')
  assert.equal(r.value.cancelled, false)
  assert.equal(called, false)
})

test('cancel when running → abort with reason and note', async () => {
  let reason = ''
  const r = await rpc({ snapshot: { running: true }, abort: (x) => { reason = x } }).dispatch('cancel')
  assert.equal(r.value.cancelled, true)
  assert.equal(reason, 'cancelled by user')
})

test('unknown endpoint returns a rejected-protocol value', async () => {
  const r = await rpc().dispatch('nope')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'unknown_endpoint')
  assert.match(r.error.message, /nope/)
})
