import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatus } from './lib/status.js'
import { createStatusTool } from './lib/tool.js'
import { createRunTool } from './lib/run-tool.js'
import { createUpdateState } from './lib/update-state.js'
import { runUpdatePipeline } from './lib/update-run.js'

export const name = 'dsh-updater'
// 工具注册要等 tools 服务;jobs.start 要等 jobs 服务
export const inject = ['tools', 'jobs']

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
  // 不用插件自身 import.meta.url:link: 安装下其真实路径是本插件仓,walk-up 永远到不了 harness。
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
  ctx.logger?.info?.('dsh-updater loaded, checkOnStart=%s', cfg.checkOnStart)

  const collect = (opts = {}) => collectStatus({ ...opts, config: cfg, env: { binPath } })
  const collectWithUpdate = async (opts = {}) => ({ ...await collect(opts), update: updateState.snapshot() })

  const runStatus = () => collect()
    .then(({ shape, checks }) => {
      const problems = checks.filter(c => c.status === 'behind' || c.status === 'diverged' || c.status === 'error')
      if (problems.length) ctx.logger?.info?.('dsh-updater: %d update-relevant results (shape=%s)', problems.length, shape.kind)
    })
    .catch(e => ctx.logger?.warn?.('dsh-updater check failed: %s', e?.message ?? e))

  if (cfg.checkOnStart) void runStatus()

  // config 值是用户可改的 patch 行:0/负数/NaN 会被 setInterval 钳到 ~1ms,造成子进程风暴
  const minutes = Number.isFinite(cfg.checkIntervalMinutes) && cfg.checkIntervalMinutes >= 1 ? cfg.checkIntervalMinutes : 30
  const timer = setInterval(() => void runStatus(), minutes * 60_000)
  timer.unref?.()
  // timer 是 cordis 不管理的资源,按教程用 ctx.effect 包一层,卸载时执行 disposer
  ctx.effect(() => () => clearInterval(timer))

  ctx.tools.register(createStatusTool({ collectStatus: collectWithUpdate }))
  ctx.tools.register(createRunTool({
    collectStatus: collect,
    startUpdate: (plan, exec) => {
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
            }).then(summary => ({
              status: summary.cancelled ? 'killed' : summary.ok ? 'completed' : 'failed',
              detail: summary.cancelled ? 'cancelled' : summary.ok ? 'update finished' : 'update finished with failures; run dsh_update_status for steps',
              output: JSON.stringify(summary, null, 2),
            }), (e) => ({
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
    },
  }))
}
