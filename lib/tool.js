export function createStatusTool({ collectStatus }) {
  return {
    name: 'dsh_update_status',
    description: 'Show dsh updater status: install shape, harness and integration repos vs upstream.',
    parameters: {
      type: 'object',
      properties: { detail: { type: 'boolean', description: 'Include commit refs in per-repo results.' } },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, _exec) {
      try {
        const { detail = true } = args ?? {}
        const { shape, checks, ...extra } = await collectStatus({})
        const KEYS = { 'up-to-date': 'upToDate', behind: 'behind', diverged: 'diverged', error: 'error', 'no-upstream': 'noUpstream' }
        const summary = { upToDate: 0, behind: 0, diverged: 0, error: 0, noUpstream: 0 }
        for (const c of checks) summary[KEYS[c.status] ?? 'error']++
        return JSON.stringify({
          shape,
          summary,
          checks: detail ? checks : checks.map(({ localRef, remoteRef, ...rest }) => rest),
          ...extra,
        }, null, 2)
      } catch (e) {
        // 兜底:聚合失败也不能让工具调用本身报错(output.schema 为 string)
        return JSON.stringify({ shape: null, error: String(e?.message ?? e) }, null, 2)
      }
    },
  }
}
