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
  // 回滚专用通道:不得携带已 abort 的 signal,否则 reset --hard 立即 AbortError,回滚永远无法落地(spec §6 绝不留半更新状态)
  const gitNoSignal = async (...args) => {
    const { stdout } = await pExec(gitBin, ['-C', path, ...args], { timeout: 120000 })
    return stdout.trim()
  }
  const rollback = async (steps) => {
    try {
      await gitNoSignal('reset', '--hard', steps.preSha)
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
  // 脏树拒绝:pull 会容忍未重叠的脏文件,一旦后续走到 rollback 的 reset --hard 就会静默销毁未提交改动——
  // 在任何变更发生前拒绝(pull 尚未开始,无回滚、无树变更)
  const dirty = await git('status', '--porcelain')
  if (dirty) {
    return {
      ok: false, rolledBack: false, cancelled: false, fromSha: preSha, toSha: preSha,
      steps: [{ step: 'pull', status: 'failed', error: 'working tree not clean; commit or stash before updating' }],
    }
  }
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
  const toSha = await gitNoSignal('rev-parse', '--short', 'HEAD') // 无信号通道:收尾读 sha 带信号会把迟到的 abort 误判成 unexpected 而非 cancelled
  return { ok, rolledBack, cancelled: false, fromSha: preSha, toSha, steps }
}
