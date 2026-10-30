import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.DSH_TEST_MODULE_ROOT) {
  console.error('Set DSH_TEST_MODULE_ROOT to the @deepseek-ai directory in your DSH installation')
  process.exit(1)
}

const suites = [
  'integration',
  'shared-pool',
  'config-reload',
  'reproduce-stale-reload',
  'dsh-profile-lifecycle',
  'hub-fixture-self-test',
  'hub-contract',
  'hub-exclusivity',
  'hub-agent-loop',
]

for (const name of suites) {
  const path = new URL(`./${name}.mjs`, import.meta.url)
  const result = spawnSync(process.execPath, [fileURLToPath(path)], { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('\n========================================')
console.log('ALL SUITES PASSED: 55 regression + 17 hub assertions = 72 assertions')
console.log('========================================\n')
