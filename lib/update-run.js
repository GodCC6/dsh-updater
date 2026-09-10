import { runHarnessUpdate } from './harness-update.js'
import { runIntegrationsUpdate } from './integrations-update.js'

export async function runUpdatePipeline({
  updateState,
  harnessPath,
  integrationsRoot,
  gitBin = 'git',
  pnpmBin = 'pnpm',
  runHarnessUpdateImpl = runHarnessUpdate,
  runIntegrationsUpdateImpl = runIntegrationsUpdate,
}) {
  const signal = updateState.signal
  updateState.stage({ target: 'pipeline', step: 'start', status: 'ok' })
  let harness = null
  let integrations = []
  let cancelled = false
  let unexpected = null
  try {
    if (harnessPath) {
      harness = await runHarnessUpdateImpl({ path: harnessPath, pnpmBin, gitBin, signal })
      updateState.stage({
        target: harnessPath, step: 'harness', status: harness.ok ? 'ok' : 'failed',
        detail: `rolledBack=${harness.rolledBack}`,
      })
      if (harness.cancelled) cancelled = true
    }
    if (!cancelled) {
      integrations = await runIntegrationsUpdateImpl({
        root: integrationsRoot, gitBin, signal,
        onTarget: (e) => updateState.stage({
          target: e.path, step: 'integration', status: e.status === 'updated' || e.status === 'up-to-date' ? 'ok' : e.status,
        }),
      })
    }
  } catch (e) {
    if (e?.cancelled) cancelled = true
    else unexpected = String(e?.message ?? e)
  }
  if (!Array.isArray(integrations)) integrations = [] // 契约违约返回:not 是数组时 every 在 try 外会抛 TypeError,越过 finish 把运行门永久卡死
  if (unexpected) updateState.stage({ target: 'pipeline', step: 'error', status: 'failed', detail: unexpected })
  const ok = !cancelled && !unexpected
    && (harness === null || harness.ok === true)
    && integrations.every(r => r.status === 'updated' || r.status === 'up-to-date')
  const summary = { ok, cancelled, harness, integrations }
  updateState.finish(summary)
  return summary
}
