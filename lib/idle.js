export function createIdleTracker({ now = () => Date.now(), jobsList, idleQuietMs }) {
  let lastActivityAt = now()
  const anyBusy = () => {
    let jobs
    try { jobs = jobsList() } catch { return true } // 探测不到 job 状态:保守当作忙
    return (jobs ?? []).some(j => j?.status === 'running' || j?.status === 'stopping')
  }
  return {
    touch() { lastActivityAt = now() },
    isIdle() {
      if (anyBusy()) return false
      return now() - lastActivityAt >= idleQuietMs
    },
  }
}
