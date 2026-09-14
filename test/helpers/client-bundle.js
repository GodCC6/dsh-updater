// 把 client.js 当作宿主那样的 classic script 加载进 fresh vm context。
//
// 宿主加载插件 bundle 用的是 document.createElement('script')(无 type=module),
// 即 classic script:没有 import/export,顶层 function 声明落在全局。这里用
// node:vm 复刻同一语义:source 以 script(而非 module)编译执行,stub 掉
// window.__ModuleLoader__ / module / require,然后:
//   - registration  = __ModuleLoader__.load 捕获到的 { id, factory }
//   - moduleFace    = registration.factory(stubRequire) 的返回值(插件面)
//   - toViewModel / nextDelayMs / createPoller = context 上的全局函数声明
//
// @param {{ react?: object }} [opts] - 覆盖 fake react(mount 只解构
//   createElement/useState/useEffect,见 client.js mount 开头)
// @returns {{ moduleFace, toViewModel, nextDelayMs, createPoller, registration }}
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_URL = new URL('../../client.js', import.meta.url)

export function fakeReact(overrides = {}) {
  return {
    createElement: (tag, attrs, ...kids) => ({ tag, attrs, kids }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => () => {},
    ...overrides,
  }
}

export function loadClientBundle(opts = {}) {
  const source = readFileSync(CLIENT_URL, 'utf8')
  const registrations = []
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (reg) => registrations.push(reg) } },
    module: { exports: {} },
    require: (s) => {
      if (s === 'react') return opts.react ?? fakeReact()
      throw new Error('unexpected require: ' + s)
    },
    console,
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  const registration = registrations[0]
  const rawFace = registration.factory(context.require)
  // vm context 里 new 出来的数组原型是 context 的 Array.prototype,host 侧
  // assert/strict 的 deepEqual 按原型比较会误报;把插件面拷回 host realm。
  const moduleFace = { inject: [...rawFace.inject], apply: rawFace.apply }
  return {
    moduleFace,
    toViewModel: context.toViewModel,
    nextDelayMs: context.nextDelayMs,
    createPoller: context.createPoller,
    registration,
  }
}
