import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatus } from './lib/status.js'
import { createStatusTool } from './lib/tool.js'
import { createRunTool } from './lib/run-tool.js'
import { createCancelTool } from './lib/cancel-tool.js'
import { createUpdateState } from './lib/update-state.js'
import { runUpdatePipeline } from './lib/update-run.js'
import { createIdleTracker } from './lib/idle.js'
import { createAutoApplier } from './lib/auto-apply.js'
import { createClientRpc } from './lib/client-rpc.js'

export const name = 'dsh-updater'
// 工具注册要等 tools;jobs.start / jobs.list 要等 jobs;session/event 要等 sessions;
// client 页 RPC 桥要等 connection(存在性守卫,见 apply 内注册块)
export const inject = ['tools', 'jobs', 'sessions', 'connection']

const DEFAULTS = {
  checkOnStart: true,
  checkIntervalMinutes: 30,
  autoApply: false,
  idleQuietMs: 120000,
  npmDistTag: 'latest',
  integrationsDir: '~/.dsh/integrations',
}

function dshBinPath() {
  // spec §2:从运行中 dsh 的 bin 路径回溯 harness 根 / npm 包。
  try { return realpathSync(process.argv[1]) } catch { return fileURLToPath(import.meta.url) }
}

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config }
  const binPath = dshBinPath()
  const updateState = createUpdateState()
  const attemptedVersions = new Map()
  ctx.logger?.info?.('dsh-updater loaded, checkOnStart=%s autoApply=%s', cfg.checkOnStart, cfg.autoApply)

  const collect = (opts = {}) => collectStatus({ ...opts, config: cfg, env: { binPath } })
  const collectWithUpdate = async (opts = {}) => ({ ...await collect(opts), update: updateState.snapshot() })

  // ---- startUpdate:手动与自动共用(begin() 互斥锁) ----
  const startUpdate = (plan, exec) => {
    if (!updateState.begin()) throw new Error('an update is already running')
    const harnessPath = plan.find(t => t.target === 'harness')?.path ?? null
    let jobId
    try {
      jobId = ctx.jobs.start({
        kind: 'dsh-update',
        label: `dsh-updater: update ${plan.length} target(s)`,
        owner: exec?.agent,
        run() {
          const done = runUpdatePipeline({
            updateState,
            harnessPath,
            integrationsRoot: expandHome(cfg.integrationsDir),
            gitBin: 'git',
            pnpmBin: 'pnpm',
          }).then(summary => {
            if (summary.ok && !summary.cancelled) updateState.notePendingRestart()
            return {
              status: summary.cancelled ? 'killed' : summary.ok ? 'completed' : 'failed',
              detail: summary.cancelled ? 'cancelled' : summary.ok ? 'update finished' : 'update finished with failures; run dsh_update_status for steps',
              output: JSON.stringify(summary, null, 2),
            }
          }, (e) => ({
            status: 'failed',
            detail: String(e?.message ?? e),
          }))
          return {
            cancel: () => updateState.abort('cancelled by user'),
            done,
          }
        },
      })
    } catch (e) {
      updateState.finish({ ok: false, cancelled: false, harness: null, integrations: [] })
      throw e
    }
    return { jobId }
  }

  // ---- idle 追踪 + 自动应用(仅 autoApply:true) ----
  let autoApplier = null
  if (cfg.autoApply) {
    const idle = createIdleTracker({
      jobsList: () => ctx.jobs.list(),
      idleQuietMs: Number.isFinite(cfg.idleQuietMs) && cfg.idleQuietMs >= 0 ? cfg.idleQuietMs : 120000,
    })
    const off = ctx.on('session/event', () => idle.touch())
    if (typeof off === 'function') ctx.effect(() => off)
    autoApplier = createAutoApplier({
      collectStatus: collect,
      isIdle: () => idle.isIdle(),
      startUpdate: (plan) => startUpdate(plan),
      getAttempted: () => attemptedVersions,
      markAttempted: (t, r) => attemptedVersions.set(t, r),
    })
  }

  // ---- 定时检查(+ 自动应用) ----
  const runStatus = () => collect()
    .then(({ shape, checks }) => {
      const problems = checks.filter(c => c.status === 'behind' || c.status === 'diverged' || c.status === 'error')
      if (problems.length) ctx.logger?.info?.('dsh-updater: %d update-relevant results (shape=%s)', problems.length, shape.kind)
    })
    .catch(e => ctx.logger?.warn?.('dsh-updater check failed: %s', e?.message ?? e))
    .then(() => {
      if (autoApplier) {
        return autoApplier.maybeAutoApply()
          .then(r => { if (r.started) ctx.logger?.info?.('dsh-updater: auto-apply started job %s (%d target(s))', r.jobId, r.plan.length) })
          .catch(e => ctx.logger?.warn?.('dsh-updater auto-apply failed: %s', e?.message ?? e))
      }
    })

  if (cfg.checkOnStart) void runStatus()

  const minutes = Number.isFinite(cfg.checkIntervalMinutes) && cfg.checkIntervalMinutes >= 1 ? cfg.checkIntervalMinutes : 30
  const timer = setInterval(() => void runStatus(), minutes * 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  // ---- client 页 RPC 桥('/dsh-updater'):与 agent 工具同源同门禁 ----
  // spike Q4:handle(channel, handler) 恰两参,无 {authority} 选项;信任栅 +
  // cookie 认证由 connection 层对 handle() 通道统一生效。handler 必须返回
  // {ok,value}|{ok:false,error} 信封——dispatch 是 async,捕获须配 await,
  // 否则 rejection 会穿透到 connection 层变成 HTTP 500(Task 3 review finding)。
  const clientRpc = createClientRpc({
    collect: collectWithUpdate,
    startUpdate: (plan) => startUpdate(plan),
    getSnapshot: () => updateState.snapshot(),
    abort: (reason) => updateState.abort(reason),
  })
  if (ctx.connection?.rpc?.handle) {
    const offRpc = ctx.connection.rpc.handle('/dsh-updater', async (endpoint, _payload, _signal) => {
      try {
        return await clientRpc.dispatch(endpoint)
      } catch (e) {
        return { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } }
      }
    })
    if (typeof offRpc === 'function') ctx.effect(() => offRpc)
  } else {
    ctx.logger?.info?.('dsh-updater: connection service absent — client rpc not registered')
  }

  // ---- 工具注册 ----
  ctx.tools.register(createStatusTool({ collectStatus: collectWithUpdate }))
  ctx.tools.register(createRunTool({ collectStatus: collect, startUpdate }))
  ctx.tools.register(createCancelTool({
    getSnapshot: () => updateState.snapshot(),
    abort: (r) => updateState.abort(r),
  }))
}
