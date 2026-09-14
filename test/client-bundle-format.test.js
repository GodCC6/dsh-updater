// client.js 的 bundle 形状回归测试(Fix round 1)。
//
// 宿主以 classic script(无 type=module)加载插件 bundle;曾因文件里用 ESM
// `export function` 导致浏览器 SyntaxError: Unexpected token 'export',
// factory 从未注册、Settings 页永远不出现。这两个测试钉死该缺陷:
//   A. parse guard:source 必须能被 new vm.Script() 以 script 语义编译。
//   B. 注册 + 纯函数暴露:vm context 里跑完后,__ModuleLoader__.load 收到
//      { id:'dsh-updater', factory },factory(require) 返回
//      { inject:['slots','locale','connection'], apply },且三个纯函数以
//      顶层 function 声明的形式落在 context 全局上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { loadClientBundle } from './helpers/client-bundle.js'

const CLIENT_URL = new URL('../client.js', import.meta.url)

test('client.js parses as a classic script (host loads bundles without type=module)', () => {
  const source = readFileSync(CLIENT_URL, 'utf8')
  assert.doesNotThrow(() => {
    new vm.Script(source, { filename: 'client.js' })   // SyntaxError = 回归
  })
  assert.match(source, /no ESM syntax/, 'classic-script constraint noted in header')
})

test('client.js registers dsh-updater via __ModuleLoader__ and exposes pure functions', () => {
  const { moduleFace, toViewModel, nextDelayMs, createPoller, registration } = loadClientBundle()
  assert.equal(registration.id, 'dsh-updater')
  assert.equal(typeof registration.factory, 'function')
  assert.deepEqual(moduleFace.inject, ['slots', 'locale', 'connection'])
  assert.equal(typeof moduleFace.apply, 'function')
  assert.equal(typeof toViewModel, 'function')
  assert.equal(typeof nextDelayMs, 'function')
  assert.equal(typeof createPoller, 'function')
})
