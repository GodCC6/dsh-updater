import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const isGitCheckout = (dir) =>
  existsSync(join(dir, '.git')) && existsSync(join(dir, 'pnpm-workspace.yaml'))

function nearestDshPackage(startDir) {
  let dir = startDir
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg?.name === '@deepseek-ai/dsh') return dir
    } catch { /* 无 package.json 或解析失败:继续向上 */ }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function detectInstallShape({ harnessRoot, binPath } = {}) {
  if (harnessRoot) {
    const root = resolve(harnessRoot)
    if (isGitCheckout(root)) return { kind: 'git', harnessRoot: root, details: {} }
  }
  if (binPath) {
    let start = dirname(binPath)
    try { start = dirname(realpathSync(binPath)) } catch { /* 解析不了就用原路径 */ }
    // 先自内向外找 git 标记(优先级最高:源码 checkout 里 apps/cli 也有同名包,但仓库根在其上方)
    for (let dir = start; ; dir = dirname(dir)) {
      if (isGitCheckout(dir)) return { kind: 'git', harnessRoot: dir, details: {} }
      if (dir === dirname(dir)) break
    }
    const pkgDir = nearestDshPackage(start)
    if (pkgDir) return { kind: 'npm', harnessRoot: pkgDir, details: { packageName: '@deepseek-ai/dsh' } }
  }
  return { kind: 'unknown', harnessRoot: harnessRoot ? resolve(harnessRoot) : null, details: {} }
}
