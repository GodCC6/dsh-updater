export function createRunTool({ collectStatus, startUpdate }) {
  return {
    name: 'dsh_update_run',
    description: 'Run the checked updates now: git-form harness (pull --ff-only, pnpm install --frozen-lockfile, pnpm build, rollback on failure) plus fast-forward integration repos. Refuses when up-to-date, diverged, or already running. Runs as a background job; check dsh_update_status for progress.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const { shape, checks } = await collectStatus({})
      if (shape.kind !== 'git') {
        return JSON.stringify({ started: false, reason: `unsupported install shape: ${shape.kind} (npm form lands in M3)` }, null, 2)
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
      if (plan.length === 0) {
        return JSON.stringify({ started: false, reason: 'nothing to update', skipped }, null, 2)
      }
      try {
        const { jobId } = await startUpdate(plan, exec)
        return JSON.stringify({
          started: true,
          jobId,
          plan,
          skipped,
          note: 'update runs in the background; check dsh_update_status for progress, restart dsh afterwards to apply the new build',
        }, null, 2)
      } catch (e) {
        return JSON.stringify({ started: false, reason: String(e?.message ?? e), plan, skipped }, null, 2)
      }
    },
  }
}
