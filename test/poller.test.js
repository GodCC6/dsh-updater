import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextDelayMs, createPoller } from '../client.js'

// fetch 是 async 函数,tick 的 apply/schedule 必然落在微任务里;
// 用一次宏任务排空保证断言前整个 tick 周期已完成(断言语义与 brief 逐字一致)。
const settle = () => new Promise(resolve => setImmediate(resolve))

test('nextDelayMs: running fast, idle slow', () => {
  assert.equal(nextDelayMs(true), 5000)
  assert.equal(nextDelayMs(false), 30000)
})

test('poller fetches immediately, then reschedules by last result; stop clears', async () => {
  const calls = []
  const timers = []
  let id = 0
  const setTimer = (fn, ms) => { const t = { id: ++id, fn, ms }; timers.push(t); return t }
  const clearTimer = (t) => { timers.splice(timers.indexOf(t), 1) }
  const values = [{ update: { running: true } }, { update: { running: false } }]
  const poller = createPoller({
    fetch: async () => values[calls.length] ?? values[values.length - 1],
    apply: (v) => calls.push(v),
    setTimer, clearTimer,
  })
  poller.start()
  await settle()
  assert.equal(calls.length, 1)                    // 立即取一次
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 5000)                 // running=true → 快轮询
  timers.shift().fn()                              // 手动触发定时
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(timers[0].ms, 30000)                // idle → 慢轮询
  poller.stop()
  assert.equal(timers.length, 0)                   // stop 清掉挂起 timer
})

test('poller survives fetch rejection and keeps schedule', async () => {
  let n = 0
  const timers = []
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }
  const clearTimer = (t) => { timers.splice(timers.indexOf(t), 1) }
  const poller = createPoller({
    fetch: async () => { n++; if (n === 1) throw new Error('rpc down'); return { update: {} } },
    apply: () => {},
    setTimer, clearTimer,
  })
  poller.start()
  await settle()
  timers.shift().fn()
  await settle()
  assert.equal(n, 2)
  assert.equal(timers.length, 1)
  poller.stop()
})
