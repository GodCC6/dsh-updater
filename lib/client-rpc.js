import { buildPlan } from './update-plan.js'

// client 页的 RPC 派发器:三端点语义与 dsh_update_status/run/cancel 完全一致。
// 返回 { ok:true, value };refusal(无可更新/不支持形态)是 value 不是 error,
// 与 agent 工具的 JSON 语义对齐。非预期 endpoint 返回 { ok:false, error } 拒绝信封——
// host handler 必须永远返回信封而不是 throw:抛错会被 connection 层变成 HTTP 500,
// 而不是结构化 RPC 错误(rpc-host.ts 语义)。
export function createClientRpc({ collect, startUpdate, getSnapshot, abort }) {
  return {
    async dispatch(endpoint) {
      switch (endpoint) {
        case 'get-status':
          // 运行中(running)→ fetch:false:客户端轮询降级为不 fetch 的快照读取,
          // 避免 5s 快轮的 git fetch 与 pipeline 的 git pull 竞态。collectStatus
          // 会把 fetch 转发到 checkGitRepo/checkIntegrations,真正跳过网络 IO。
          return { ok: true, value: await collect({ fetch: !getSnapshot()?.running }) }
        case 'start-update': {
          const { shape, checks } = await collect()
          const { plan, skipped, refusal } = buildPlan({ shape, checks })
          if (refusal) return { ok: true, value: { started: false, reason: refusal.reason, skipped } }
          try {
            const { jobId } = await startUpdate(plan)
            return { ok: true, value: {
              started: true, jobId, plan, skipped,
              note: 'update runs in the background; check dsh_update_status for progress, restart dsh afterwards to apply the new build',
            } }
          } catch (e) {
            return { ok: true, value: { started: false, reason: String(e?.message ?? e), plan, skipped } }
          }
        }
        case 'cancel': {
          const snap = getSnapshot()
          if (!snap?.running) return { ok: true, value: { cancelled: false, reason: 'no update in progress' } }
          abort('cancelled by user')
          return { ok: true, value: {
            cancelled: true,
            note: 'abort requested; the running job will roll back any partial harness build and settle as killed — check dsh_update_status',
          } }
        }
        default:
          return { ok: false, error: { code: 'unknown_endpoint', message: `unknown endpoint: ${endpoint}` } }
      }
    },
  }
}
