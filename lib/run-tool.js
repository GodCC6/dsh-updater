import { buildPlan } from './update-plan.js'

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
      const { plan, skipped, refusal } = buildPlan({ shape, checks })
      if (refusal) return JSON.stringify({ started: false, reason: refusal.reason, skipped }, null, 2)
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
