// buildPlan: 把一次 collect 的 checks 变成更新计划。纯函数,agent 工具与 RPC 共用。
export function buildPlan({ shape, checks }) {
  if (shape.kind !== 'git') {
    return { plan: [], skipped: [], refusal: { reason: `unsupported install shape: ${shape.kind} (npm form lands in M3)` } }
  }
  const plan = []
  const skipped = []
  const harness = checks.find(c => c.kind === 'harness-git')
  if (harness) {
    if (harness.status === 'behind') plan.push({ target: 'harness', path: harness.target, behind: harness.behindCount })
    else skipped.push({ target: harness.target, reason: harness.status === 'diverged' ? 'diverged: manual merge/rebase required' : `harness status ${harness.status}` })
  }
  for (const c of checks.filter(c => c.kind === 'integration')) {
    if (c.status === 'behind') plan.push({ target: c.target, behind: c.behindCount })
    else skipped.push({ target: c.target, reason: c.status === 'diverged' ? 'diverged: manual action required' : `status ${c.status}` })
  }
  if (plan.length === 0) return { plan, skipped, refusal: { reason: 'nothing to update', skipped } }
  return { plan, skipped, refusal: undefined }
}
