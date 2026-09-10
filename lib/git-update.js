import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExec = promisify(execFile)

function cancelledError() {
  const err = new Error('update cancelled')
  err.cancelled = true
  return err
}

async function git(path, args, gitBin, signal) {
  const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 120000, signal })
  return stdout.trim()
}

export async function updateGitRepo({ path, gitBin = 'git', signal } = {}) {
  const base = { target: path, fromSha: null, toSha: null, ahead: 0, behind: 0 }
  try {
    await git(path, ['fetch', '--quiet'], gitBin, signal)
    const fromSha = await git(path, ['rev-parse', '--short', 'HEAD'], gitBin, signal)
    let upstreamSha
    try { upstreamSha = await git(path, ['rev-parse', '--short', '@{upstream}'], gitBin, signal) }
    catch { return { ...base, fromSha, status: 'failed', error: 'no upstream configured' } }
    const count = async (range) => parseInt(await git(path, ['rev-list', '--count', range], gitBin, signal), 10)
    const behind = await count('HEAD..@{upstream}')
    const ahead = await count('@{upstream}..HEAD')
    if (ahead > 0 && behind > 0) return { ...base, fromSha, ahead, behind, status: 'diverged' }
    if (behind === 0) return { ...base, fromSha, toSha: fromSha, ahead, behind, status: 'up-to-date' }
    await git(path, ['pull', '--ff-only', '--quiet'], gitBin, signal)
    const toSha = await git(path, ['rev-parse', '--short', 'HEAD'], gitBin, signal)
    return { ...base, fromSha, toSha, ahead, behind, status: 'updated' }
  } catch (e) {
    if (e?.name === 'AbortError') throw cancelledError()
    return { ...base, status: 'failed', error: String(e.stderr || e.message).split('\n')[0] }
  }
}
