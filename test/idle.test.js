import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdleTracker } from '../lib/idle.js'

// 可控时钟
function clock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('idle when no running job and quiet long enough', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [{ status: 'completed' }], idleQuietMs: 2000 })
  c.advance(2000)
  assert.equal(tr.isIdle(), true)
})

test('not idle while a job is running', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [{ status: 'running' }], idleQuietMs: 2000 })
  c.advance(5000)
  assert.equal(tr.isIdle(), false)
})

test('not idle while a job is stopping', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [{ status: 'stopping' }], idleQuietMs: 2000 })
  c.advance(5000)
  assert.equal(tr.isIdle(), false)
})

test('not idle before quiet threshold elapses', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [], idleQuietMs: 2000 })
  c.advance(1999)
  assert.equal(tr.isIdle(), false)
})

test('touch resets the quiet timer', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [], idleQuietMs: 2000 })
  c.advance(1500)
  tr.touch()          // 活动:重置
  c.advance(1500)     // 距上次活动仅 1500 < 2000
  assert.equal(tr.isIdle(), false)
  c.advance(500)      // 现在距上次 touch 2000
  assert.equal(tr.isIdle(), true)
})

test('jobsList throwing → treated as not idle, never throws', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => { throw new Error('no jobs service') }, idleQuietMs: 2000 })
  c.advance(5000)
  assert.equal(tr.isIdle(), false)
})

test('starts non-idle at construction (no immediate auto-apply)', () => {
  const c = clock()
  const tr = createIdleTracker({ now: c.now, jobsList: () => [], idleQuietMs: 2000 })
  assert.equal(tr.isIdle(), false) // 距构造 0ms < 2000
})
