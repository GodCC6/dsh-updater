import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkGitRepo } from './git-check.js'

export function listIntegrationRepos({ root, fs = { existsSync, readdirSync } }) {
  if (!root || !fs.existsSync(root)) return []
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // root 存在但不可枚举(文件 → ENOTDIR、EACCES 等):单点失败不破坏聚合
  }
  return entries
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => {
      // 两种真实布局:一级目录本身是 git 仓,或其 repo/ 子目录才是(如 superpowers/repo/)。直接仓优先。
      const direct = join(root, d.name)
      if (fs.existsSync(join(direct, '.git'))) return { path: direct, name: d.name }
      const nested = join(direct, 'repo')
      if (fs.existsSync(join(nested, '.git'))) return { path: nested, name: d.name }
      return null
    })
    .filter(Boolean)
}

export async function checkIntegrations({ root, fetch = true }) {
  const repos = listIntegrationRepos({ root })
  return Promise.all(repos.map(r => checkGitRepo({ path: r.path, fetch, kind: 'integration' })))
}
