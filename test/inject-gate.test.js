import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inject, apply } from '../index.js'
import { gatedCtx } from './helpers/gated-ctx.js'

// 这组测试守的是「apply() 触碰的每个服务都已声明」——顶层 inject 里的,或
// ctx.inject() 子 fiber 里的。fake ctx 的门禁语义见 helpers/gated-ctx.js。

test('apply survives a cordis-gated ctx built from the declared inject', () => {
  const { ctx } = gatedCtx(inject)
  // checkOnStart:false —— 这里只验证 apply 同步路径上的服务门禁
  assert.doesNotThrow(() => apply(ctx, { checkOnStart: false }))
})

test('autoApply path also survives the gate', () => {
  const { ctx } = gatedCtx(inject)
  assert.doesNotThrow(() => apply(ctx, { checkOnStart: false, autoApply: true }))
})

test('the three rpc endpoints land as exact routes on the shared /api channel', () => {
  const { ctx, routes } = gatedCtx(inject)
  apply(ctx, { checkOnStart: false })
  assert.deepEqual(routes.map(r => r.path).sort(), [
    '/api/dsh-updater.cancel',
    '/api/dsh-updater.get-status',
    '/api/dsh-updater.start-update',
  ])
  // 全部经 connection.fetch.register —— 没有一条走 webServer(见 gated-ctx 顶注)
  assert.ok(routes.every(r => r.methods?.includes('POST')))
})

test('connection stays out of the top-level inject', () => {
  // vendored cordis 没有 optional inject(Inject = (keyof M)[] | {…},全 required),
  // 所以 connection 一旦上顶层,没有它的 profile 下整个插件——连 3 个 agent 工具
  // 一起——都不会加载。它只能待在 ctx.inject() 子 fiber 里。
  assert.deepEqual([...inject].sort(), ['jobs', 'sessions', 'tools'])
})

test('without connection the tools still register', () => {
  // 模拟 headless:子 fiber 永不就绪,插件主体照常工作。
  const { ctx, routes } = gatedCtx(inject)
  let registered = 0
  const noWeb = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'inject') return () => {} // 依赖不满足 → 回调不执行
      if (prop === 'tools') return { register: () => { registered += 1; return () => {} } }
      return Reflect.get(target, prop, receiver)
    },
  })
  assert.doesNotThrow(() => apply(noWeb, { checkOnStart: false }))
  assert.equal(registered, 3)
  assert.deepEqual(routes, [])
})
