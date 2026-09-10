export function createUpdateState() {
  let running = false
  let controller = null
  let log = []
  let lastResult = null
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
    snapshot() {
      return { running, log: [...log], lastResult }
    },
  }
}
