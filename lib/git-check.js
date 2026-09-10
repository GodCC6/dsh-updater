import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const pExec = promisify(execFile)

async function git(path, args, gitBin) {
  const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 30000 })
  return stdout.trim()
}

export async function checkGitRepo({ path, fetch = true, gitBin = 'git', kind = 'integration' }) {
  const base = { target: path, kind, behindCount: 0, localRef: null, remoteRef: null }
  try {
    if (fetch) await git(path, ['fetch', '--quiet'], gitBin)
  } catch (e) {
    return { ...base, status: 'error', error: String(e.stderr || e.message).split('\n')[0] }
  }
  const counts = async (range) => {
    try { return parseInt(await git(path, ['rev-list', '--count', range], gitBin), 10) }
    catch { return null }
  }
  try {
    const local = await git(path, ['rev-parse', '--short', 'HEAD'], gitBin)
    let upstream
    try { upstream = await git(path, ['rev-parse', '--short', '@{upstream}'], gitBin) }
    catch { return { ...base, localRef: local, status: 'no-upstream' } }
    const behind = await counts(`HEAD..@{upstream}`)
    const ahead = await counts(`@{upstream}..HEAD`)
    if (behind === null || ahead === null) return { ...base, localRef: local, remoteRef: upstream, status: 'error', error: 'rev-list failed' }
    const status = behind > 0 && ahead > 0 ? 'diverged' : behind > 0 ? 'behind' : 'up-to-date'
    return { ...base, localRef: local, remoteRef: upstream, status, behindCount: behind }
  } catch (e) {
    return { ...base, status: 'error', error: String(e.stderr || e.message).split('\n')[0] }
  }
}
