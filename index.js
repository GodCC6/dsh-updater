import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectStatus } from './lib/status.js'
import { createStatusTool } from './lib/tool.js'

export const name = 'dsh-updater'
// 工具注册要等 tools 服务就绪(与 harness 全部插件一致的要求)
export const inject = ['tools']

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

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config }
  const binPath = dshBinPath()
  ctx.logger?.info?.('dsh-updater loaded, checkOnStart=%s', cfg.checkOnStart)
  const runStatus = () => collectStatus({ config: cfg, env: { binPath }, fetch: true })
    .then(({ shape, checks }) => {
      const problems = checks.filter(c => c.status === 'behind' || c.status === 'diverged' || c.status === 'error')
      if (problems.length) ctx.logger?.info?.('dsh-updater: %d update-relevant results (shape=%s)', problems.length, shape.kind)
    })
    .catch(e => ctx.logger?.warn?.('dsh-updater check failed: %s', e?.message ?? e))

  if (cfg.checkOnStart) void runStatus()

  const timer = setInterval(() => void runStatus(), cfg.checkIntervalMinutes * 60_000)
  timer.unref?.()
  // timer 是 cordis 不管理的资源,按教程用 ctx.effect 包一层,卸载时执行 disposer
  ctx.effect(() => () => clearInterval(timer))

  ctx.tools.register(createStatusTool({
    collectStatus: (opts = {}) => collectStatus({ ...opts, config: cfg, env: { binPath } }),
  }))
}
