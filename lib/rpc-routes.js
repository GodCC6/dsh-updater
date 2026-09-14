// Connection RPC 的 host 半边,挂在共享 /api 通道的**精确 Fetch 路由**上。
//
// 为什么不是 connection.rpc.handle('/dsh-updater', …):那条路径在 harness 里是坏的。
// rpc-host.ts:178 的 register() 写成 `owner.effect(() => owner.webServer.register(route))`,
// 而 `connection.rpc` 是个 getter——经 cordis 的 shadow 机制(utils.ts:188 createShadow)
// 取值时,getter 里的 this.ctx 带上了 symbols.shadow = connection 插件自己的 ctx,于是
// reflect.ts:155 用**那个** fiber 去解析 webServer。connection 插件的 inject 只有
// ['credentials'],所以必然抛 `cannot get property "webServer" without inject`——
// 调用方无论怎么声明 inject 都修不好。全仓零 rpc.handle 调用点,我们是第一个用户。
//
// connection.fetch.register 则只往 Map 里塞路由(rpc-host.ts:139 registerFetchRoute),
// 完全不碰 webServer;harness 内有 5 处在用。共享通道的 createSharedFetchHandler 先查
// 精确路由再落到 interceptor,所以与 api/gateway 占用的 /api interceptor 不冲突。

/** 与 client 侧 rpc.call('/api', `dsh-updater.<endpoint>`) 对应的端点名。 */
export const RPC_ENDPOINTS = ['get-status', 'start-update', 'cancel']

/**
 * 短名 → 线上端点名。共享 /api 通道靠前缀区分归属,所以线上名带 `dsh-updater.`;
 * client 的 rpc.call(channel, endpoint) 把**整个** endpoint 同时写进 URL 和信封的
 * method 字段(client/rpc.ts:40,44),两边必须按线上名比,不能拿短名比。
 */
export const wireName = (endpoint) => `dsh-updater.${endpoint}`

/** client 侧 parseConnectionResponse 对失败信封的硬要求:code/message/details 三者齐全。 */
const INVALID_RPC_ID = 'invalid-request'

function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

function failure(code, message) {
  // details 必填:client 的 parseConnectionResponse(rpc.ts:92)对非 record 的 details
  // 直接抛 TypeError,那会把结构化拒绝变成传输失败。
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * 构造一条端点的精确 Fetch 路由描述。
 * @param endpoint - 三端点之一
 * @param dispatch - createClientRpc().dispatch,返回 {ok,value}|{ok:false,error} 信封
 */
export function rpcRoute(endpoint, dispatch) {
  const wire = wireName(endpoint)
  return {
    path: `/api/${wire}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body
      try {
        body = await request.json()
      } catch {
        return envelope(INVALID_RPC_ID, failure('gateway/bad-request', 'body is not JSON'))
      }

      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : INVALID_RPC_ID
      if (body?.type !== 'client-request') {
        return envelope(rpcId, failure('gateway/bad-request', 'invalid client-request message'))
      }
      if (body.method !== wire) {
        return envelope(rpcId, failure(
          'gateway/bad-request',
          `method ${JSON.stringify(String(body.method))} does not match endpoint ${JSON.stringify(wire)}`,
        ))
      }

      // dispatch 永不 throw(自己返回拒绝信封),这里的兜底只防实现走样:
      // 抛到 connection 层会变成 HTTP 500,client 侧就成了传输失败而非结构化错误。
      try {
        return envelope(rpcId, await dispatch(endpoint))
      } catch (e) {
        return envelope(rpcId, failure('internal', String(e?.message ?? e)))
      }
    },
  }
}
