import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectInstallShape } from './detect.js'
import { checkGitRepo } from './git-check.js'
import { checkNpmPackage } from './npm-check.js'
import { checkIntegrations } from './integrations.js'

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p
}

export async function collectStatus({ config, env = {}, fetch = true }) {
  const shape = detectInstallShape({ harnessRoot: env.harnessRoot, binPath: env.binPath })
  const checks = []
  if (shape.kind === 'git') {
    checks.push(await checkGitRepo({ path: shape.harnessRoot, fetch, kind: 'harness-git' }))
  } else if (shape.kind === 'npm') {
    let currentVersion = null
    try { currentVersion = JSON.parse(readFileSync(join(shape.harnessRoot, 'package.json'), 'utf8')).version } catch { /* → error path */ }
    checks.push(await checkNpmPackage({ currentVersion, distTag: config.npmDistTag }))
  }
  if (shape.kind !== 'unknown') {
    checks.push(...await checkIntegrations({ root: expandHome(config.integrationsDir), fetch }))
  }
  return { shape, checks }
}
