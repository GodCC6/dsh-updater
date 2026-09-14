// 忠实一点的 cordis ctx fake。
//
// 真实的 ctx 是 Proxy:读取未在 inject 里声明的服务会**抛**
// `cannot get property "X" without inject`(vendor/cordis/src/reflect.ts:144),
// 而不是返回 undefined。用普通对象当 fake 时 `ctx.svc?.x` 会静默走 else 分支,
// 于是整类「inject 漏声明」的缺陷测不出来——M5 漏声明 webServer 就是这么进的
// 生产:connection.rpc.handle() 内部以「调用方 ctx」注册路由
// (rpc-host.ts:178 `owner.effect(() => owner.webServer.register(route))`),
// 所以调用方自己必须 inject webServer。
//
// @param declared - 顶层已声明的服务名(通常直接传插件导出的 inject)
// @returns { ctx, routes, channels, logs } - 后三者是注册与日志的观察点
export function gatedCtx(declared) {
  const routes = []
  const logs = []

  const services = () => ({
    tools: { register: () => () => {} },
    jobs: { start: () => 'job-1', list: () => [] },
    sessions: {},
    connection: {
      rpc: {
        // rpc.handle 在 harness 里是坏的:它是个 getter,经 cordis shadow 取值后
        // 内部用 connection 插件自己的 fiber 去解析 webServer,而那个插件
        // inject 只有 ['credentials'] —— 调用方声明什么都没用。这里照抛,免得
        // fake 给出虚假的绿灯(M5 就是这么漏过去的)。
        handle: () => {
          throw new Error('cannot get property "webServer" without inject')
        },
      },
      // fetch.register 只往 Map 里塞,不碰 webServer —— 这条路是通的。
      fetch: {
        register: (route) => { routes.push(route); return () => {} },
      },
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  })

  const make = (names) => {
    const own = {
      logger: {
        info: (...a) => logs.push(a[0]),
        warn: (...a) => logs.push(a[0]),
      },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      on: () => () => {},
      // cordis 的 ctx.inject(deps, cb):子 fiber 的 declared 是父集合 ∪ deps
      inject: (deps, cb) => cb(make([...names, ...deps])),
    }
    const self = new Proxy(own, {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        if (typeof prop !== 'string') return undefined
        if (!names.includes(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return services()[prop]
      },
      has: (target, prop) => Reflect.has(target, prop) || (typeof prop === 'string' && names.includes(prop)),
    })
    return self
  }

  return { ctx: make([...declared]), routes, logs }
}
