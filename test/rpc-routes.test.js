import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RPC_ENDPOINTS, rpcRoute } from '../lib/rpc-routes.js'

const ok = async (ep) => ({ ok: true, value: { echo: ep } })

function post(endpoint, body, { contentType = 'application/json' } = {}) {
  return new Request(`http://127.0.0.1/api/dsh-updater.${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

// method 必须是**线上名**(`dsh-updater.<ep>`):client 的 rpc.call(channel, endpoint)
// 把整个 endpoint 同时写进 URL 和信封的 method 字段(client/rpc.ts:40,44)。这里刻意
// 写死线上格式而不是复用实现里的 wireName——端到端验收就是被这个失配抓出来的
// (单测当时用短名构造信封,自洽地绿着,真实 client 却被判不匹配)。
const envelope = (rpcId, method, payload = {}) => ({ type: 'client-request', rpcId, method, payload })
const wire = (ep) => `dsh-updater.${ep}`

test('route shape matches what connection.fetch.register accepts', () => {
  const r = rpcRoute('get-status', ok)
  assert.equal(r.path, '/api/dsh-updater.get-status')
  assert.deepEqual(r.methods, ['POST'])
  assert.equal(r.requestBody, 'buffered')
  assert.equal(typeof r.fetch, 'function')
})

test('all three endpoints get a route under the shared /api channel', () => {
  assert.deepEqual(RPC_ENDPOINTS, ['get-status', 'start-update', 'cancel'])
  for (const ep of RPC_ENDPOINTS) {
    assert.equal(rpcRoute(ep, ok).path, `/api/dsh-updater.${ep}`)
  }
})

test('happy path returns a server-response envelope echoing the rpcId', async () => {
  const res = await rpcRoute('get-status', ok).fetch(post('get-status', envelope('abc-1', wire('get-status'))))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'abc-1')
  // dispatch 收到的是**短名**——线上名只活在 wire 层
  assert.deepEqual(body.result, { ok: true, value: { echo: 'get-status' } })
})

test('every endpoint accepts its own wire method name', async () => {
  for (const ep of RPC_ENDPOINTS) {
    const res = await rpcRoute(ep, ok).fetch(post(ep, envelope('r', wire(ep))))
    const { result } = await res.json()
    assert.equal(result.ok, true, `${ep} should accept ${wire(ep)}`)
    assert.deepEqual(result.value, { echo: ep })
  }
})

test('the bare short name is refused — that was the live mismatch', async () => {
  // client 永远发线上名;收到短名说明调用方没按 /api 通道的前缀约定发。
  const res = await rpcRoute('get-status', ok).fetch(post('get-status', envelope('r', 'get-status')))
  const { result } = await res.json()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/bad-request')
  assert.match(result.error.message, /does not match endpoint/)
})

test('non-JSON content type is refused before the body is read', async () => {
  const res = await rpcRoute('cancel', ok).fetch(post('cancel', 'x', { contentType: 'text/plain' }))
  assert.equal(res.status, 415)
})

test('method/endpoint mismatch is a structured refusal, not a transport failure', async () => {
  const res = await rpcRoute('cancel', ok).fetch(post('cancel', envelope('r-2', wire('start-update'))))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.rpcId, 'r-2')
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'gateway/bad-request')
  assert.match(body.result.error.message, /does not match endpoint/)
})

test('malformed body still answers with a parseable envelope', async () => {
  const res = await rpcRoute('get-status', ok).fetch(post('get-status', '{not json'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.rpcId, 'invalid-request')
  assert.equal(body.result.ok, false)
})

test('a throwing dispatch becomes an internal envelope, never HTTP 500', async () => {
  // 500 会被 client 侧当成传输失败(rpc.ts:53),吞掉结构化错误信息。
  const boom = async () => { throw new Error('kaboom') }
  const res = await rpcRoute('start-update', boom).fetch(post('start-update', envelope('r-3', wire('start-update'))))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'internal')
  assert.match(body.result.error.message, /kaboom/)
})

test('every failure envelope carries details — client parsing requires it', async () => {
  // client 侧 parseConnectionResponse(rpc.ts:92)对非 record 的 details 直接抛
  // TypeError,结构化拒绝就退化成传输失败。这条守的是那个契约。
  const cases = [
    rpcRoute('get-status', ok).fetch(post('get-status', '{not json')),
    rpcRoute('cancel', ok).fetch(post('cancel', envelope('r', wire('start-update')))),
    rpcRoute('cancel', ok).fetch(post('cancel', { type: 'nope', rpcId: 'r' })),
    rpcRoute('cancel', async () => { throw new Error('x') }).fetch(post('cancel', envelope('r', wire('cancel')))),
  ]
  for (const res of await Promise.all(cases)) {
    const { result } = await res.json()
    assert.equal(result.ok, false)
    assert.equal(typeof result.error.code, 'string')
    assert.equal(typeof result.error.message, 'string')
    assert.ok(result.error.details && typeof result.error.details === 'object'
      && !Array.isArray(result.error.details), 'details must be a record')
  }
})
