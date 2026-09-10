export function createCancelTool({ getSnapshot, abort }) {
  return {
    name: 'dsh_update_cancel',
    description: 'Cancel the update currently running in the background. Aborts the running job; any partial harness build is rolled back and the job settles as killed. Reports "no update in progress" when nothing is running.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args, _exec) {
      const snap = getSnapshot()
      if (!snap?.running) {
        return JSON.stringify({ cancelled: false, reason: 'no update in progress' }, null, 2)
      }
      abort('cancelled by user')
      return JSON.stringify({
        cancelled: true,
        note: 'abort requested; the running job will roll back any partial harness build and settle as killed — check dsh_update_status',
      }, null, 2)
    },
  }
}
