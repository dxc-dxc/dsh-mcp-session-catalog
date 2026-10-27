import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
if (!process.env.DSH_TEST_MODULE_ROOT) {
  console.error('Set DSH_TEST_MODULE_ROOT to the @deepseek-ai directory in your DSH installation')
  process.exit(1)
}
for (const name of ['integration', 'shared-pool', 'config-reload', 'reproduce-stale-reload', 'dsh-profile-lifecycle']) {
  const path = new URL(`./${name}.mjs`, import.meta.url)
  const result = spawnSync(process.execPath, [fileURLToPath(path)], { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
