export function createUpdateState() {
  let running = false
  let controller = null
  let log = []
  let lastResult = null
  let pendingRestart = false
  return {
    begin() {
      if (running) return false
      running = true
      controller = new AbortController()
      log = []
      lastResult = null
      return true
    },
    abort(reason) {
      controller?.abort(new Error(reason ?? 'update cancelled'))
    },
    get signal() {
      return controller?.signal
    },
    stage(entry) {
      log.push({ at: Date.now(), ...entry })
    },
    finish(summary) {
      running = false
      lastResult = { finishedAt: Date.now(), ...summary }
    },
    notePendingRestart() {
      pendingRestart = true
    },
    clearPendingRestart() {
      pendingRestart = false
    },
    snapshot() {
      return { running, log: [...log], lastResult, pendingRestart }
    },
  }
}
