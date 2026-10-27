// Regression test: verifies that after a configuration reload, a running agent's
// subsequent tool call does NOT resurrect or keep the stale lease, and the old
// registrations are cleanly revoked once idle.
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { apply } from '../index.mjs'

const base = process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the @deepseek-ai directory in the target DSH installation')
const dshImport = path => pathToFileURL(join(base, path)).href
const { Context } = await import(dshImport('cordis/lib/index.js'))
const { default: Tools } = await import(dshImport('dsh-tools/lib/index.js'))
const { default: SystemPrompt } = await import(dshImport('dsh-system-prompt/lib/index.js'))
const { createScope } = await import(dshImport('dsh-scope/lib/index.js'))
const temp = await mkdtemp(join(tmpdir(), 'mcp-reload-regression-'))
const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
const file = join(temp, 'servers.json')
const definition = extra => ({ serverName: 'demo', command: process.execPath, args: [fake], ...extra })
const ctx = new Context()
new SystemPrompt(ctx, {})
new Tools(ctx)
const agent = { id: 'regression', session: { id: 'regression' }, status: 'idle' }
const scope = createScope(ctx, agent)
agent.ctx = scope.ctx
const signal = new AbortController().signal
const run = (name, args = {}) => ctx.tools.get(name, agent).execute(args, { agent, signal })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }

try {
  await writeFile(file, JSON.stringify({ servers: [definition({})] }))
  apply(ctx, { serversFile: file, cacheFile: join(temp, 'cache.json') })
  await run('mcp_load', { server: 'demo' })
  const previous = JSON.parse(await run('mcp__demo__identity')).pid

  // 模拟 Agent 处于 running 状态时配置文件发生变动
  agent.status = 'running'
  await writeFile(file, JSON.stringify({ servers: [definition({ env: { CHANGED: 'yes' } })] }))
  await run('mcp_catalog')

  // 关键断言 1：已退役的旧工具在没有在途 RPC 时已被立即注销，模型不会再看到或调到旧工具
  assert.equal(ctx.tools.get('mcp__demo__identity', agent), undefined)

  // Agent 进入 idle 状态
  agent.status = 'idle'
  ctx.emit('agent/status', { agent, status: 'idle' })

  // 关键断言 2：再次调用 mcp_load，将根据新配置拉起全新进程，并获得新 PID
  await run('mcp_load', { server: 'demo' })
  const afterReLoad = JSON.parse(await run('mcp__demo__identity')).pid
  assert.notEqual(afterReLoad, previous)
  assert.equal(alive(afterReLoad), true)

  // 关键断言 3：旧进程在没有引用后已被安全杀灭退出
  await sleep(60)
  assert.equal(alive(previous), false)

  console.log('PASS: stale reload race condition verified as fully resolved')
} finally {
  ctx.emit('dispose')
  await scope.dispose()
  const resolved = await realpath(temp)
  assert.equal(dirname(resolved), await realpath(tmpdir()))
  assert.ok(basename(resolved).startsWith('mcp-reload-regression-'))
  await rm(resolved, { recursive: true, force: true })
}
