import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { updateGitRepo } from './git-update.js'

const pExec = promisify(execFile)

function cancelledError() {
  const err = new Error('update cancelled')
  err.cancelled = true
  return err
}

export async function runHarnessUpdate({ path, pnpmBin = 'pnpm', gitBin = 'git', signal } = {}) {
  const git = async (...args) => {
    const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 120000, signal })
    return stdout.trim()
  }
  const rollback = async (steps) => {
    try {
      await git('reset', '--hard', steps.preSha)
      steps.push({ step: 'rollback', status: 'ok', detail: `reset --hard ${steps.preSha}` })
      return true
    } catch (e) {
      steps.push({ step: 'rollback', status: 'failed', error: String(e.stderr || e.message).split('\n')[0] })
      return false
    }
  }
  const preSha = await (async () => {
    try { return await git('rev-parse', '--short', 'HEAD') }
    catch (e) {
      if (e?.name === 'AbortError') throw cancelledError() // 起始前即取消:无树变更,直接以取消标记上抛
      throw e
    }
  })()
  const steps = []
  steps.preSha = preSha // 供 rollback 闭包读取的附着字段,不参与序列化语义
  const pull = await updateGitRepo({ path, gitBin, signal })
  steps.push({ step: 'pull', status: pull.status, fromSha: pull.fromSha, toSha: pull.toSha, error: pull.error })
  if (pull.status === 'diverged' || pull.status === 'failed') {
    delete steps.preSha
    return { ok: false, rolledBack: false, cancelled: false, fromSha: preSha, toSha: preSha, steps }
  }
  if (pull.status === 'up-to-date') {
    delete steps.preSha
    return { ok: true, rolledBack: false, cancelled: false, fromSha: preSha, toSha: preSha, steps }
  }
  const runPnpm = async (args, step) => {
    try {
      await pExec(pnpmBin, args, { cwd: path, timeout: 600000, signal })
      steps.push({ step, status: 'ok' })
      return true
    } catch (e) {
      if (e?.name === 'AbortError') {
        await rollback(steps) // 尽力回滚,再抛取消
        throw cancelledError()
      }
      steps.push({ step, status: 'failed', error: String(e.stderr || e.message).split('\n')[0] })
      return false
    }
  }
  let ok = await runPnpm(['install', '--frozen-lockfile'], 'install')
  if (ok) ok = await runPnpm(['build'], 'build')
  let rolledBack = false
  if (!ok) rolledBack = await rollback(steps)
  delete steps.preSha
  const toSha = await git('rev-parse', '--short', 'HEAD')
  return { ok, rolledBack, cancelled: false, fromSha: preSha, toSha, steps }
}
