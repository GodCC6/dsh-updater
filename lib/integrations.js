import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkGitRepo } from './git-check.js'

export function listIntegrationRepos({ root, fs = { existsSync, readdirSync } }) {
  if (!root || !fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .filter(d => fs.existsSync(join(root, d.name, '.git')))
    .map(d => ({ path: join(root, d.name), name: d.name }))
}

export async function checkIntegrations({ root, fetch = true }) {
  const repos = listIntegrationRepos({ root })
  return Promise.all(repos.map(r => checkGitRepo({ path: r.path, fetch, kind: 'integration' })))
}
