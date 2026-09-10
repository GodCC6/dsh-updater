import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse, isNewer } from './semver.js'

const pExec = promisify(execFile)

export async function checkNpmPackage({ packageName = '@deepseek-ai/dsh', currentVersion, distTag = 'latest', npmBin = 'npm', kind = 'harness-npm' }) {
  const base = { target: packageName, kind, behindCount: 0, localRef: currentVersion ?? null, remoteRef: null }
  if (!parse(currentVersion ?? '')) {
    return { ...base, status: 'error', error: `unparseable current version: ${currentVersion}` }
  }
  let remote
  try {
    const { stdout } = await pExec(npmBin, ['view', `${packageName}@${distTag}`, 'version'], { timeout: 30000 })
    remote = stdout.trim().split('\n').pop()
  } catch (e) {
    return { ...base, status: 'error', error: String(e.stderr || e.message).split('\n')[0] }
  }
  if (!parse(remote)) return { ...base, status: 'error', error: `unparseable remote version: ${remote}` }
  const newer = isNewer(remote, currentVersion)
  return { ...base, remoteRef: remote, status: newer ? 'behind' : 'up-to-date', behindCount: newer ? 1 : 0 }
}
