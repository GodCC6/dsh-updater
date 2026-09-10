export function createAutoApplier({ collectStatus, isIdle, startUpdate, getAttempted, markAttempted }) {
  return {
    async maybeAutoApply() {
      const { shape, checks } = await collectStatus()
      if (shape?.kind !== 'git') return { started: false, reason: 'shape not git' }
      const attempted = getAttempted()
      const plan = []
      for (const c of checks) {
        if (c.status !== 'behind') continue                 // diverged/dirty/error/up-to-date 不动
        if (attempted.get(c.target) === c.remoteRef) continue // 同 remoteRef 已试过,不重试
        if (c.kind === 'harness-git') plan.push({ target: 'harness', path: c.target, behind: c.behindCount })
        else if (c.kind === 'integration') plan.push({ target: c.target, behind: c.behindCount })
      }
      if (plan.length === 0) return { started: false, reason: 'nothing new to auto-apply' }
      if (!isIdle()) return { started: false, reason: 'not idle' }
      // 先标记再启动:避免下一轮定时器在本轮 job 未结束时重复触发同版本
      for (const c of checks) {
        if (c.status === 'behind') markAttempted(c.target, c.remoteRef)
      }
      try {
        const { jobId } = await startUpdate(plan)
        return { started: true, jobId, plan }
      } catch (e) {
        return { started: false, reason: String(e?.message ?? e), plan }
      }
    },
  }
}
