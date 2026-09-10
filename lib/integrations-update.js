import { listIntegrationRepos } from './integrations.js'
import { updateGitRepo } from './git-update.js'

export async function runIntegrationsUpdate({ root, gitBin = 'git', signal, onTarget } = {}) {
  const repos = listIntegrationRepos({ root })
  const results = []
  for (const repo of repos) {
    const r = await updateGitRepo({ path: repo.path, gitBin, signal })
    const entry = { name: repo.name, path: repo.path, ...r }
    results.push(entry)
    onTarget?.(entry)
  }
  return results
}
