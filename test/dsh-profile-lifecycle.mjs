// Uses the actual DSH Loader, tool registry and scope implementation.
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { apply } from '../index.mjs'

const base = process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the DSH @deepseek-ai directory')
const load = path => import(pathToFileURL(join(base, path)).href)
const { Context } = await load('cordis/lib/index.js')
const { default: Loader, EntryTree } = await load('cordis-plugin-loader/lib/index.js')
const { default: Tools } = await load('dsh-tools/lib/index.js')
const { default: SystemPrompt } = await load('dsh-system-prompt/lib/index.js')
const { createScope } = await load('dsh-scope/lib/index.js')
const temp = await mkdtemp(join(tmpdir(), 'dsh-profile-lifecycle-'))
const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
const cacheFile = join(temp, 'cache.json')
const ctx = new Context()
new SystemPrompt(ctx, {})
new Tools(ctx)
const loader = new Loader(ctx)
loader.root.data = []
// Enabled official entries must never launch real external software in the test.
loader.import = async () => ({ apply() {} })
const agent = { id: 'profile-agent', session: { id: 'profile-agent' }, status: 'idle' }
const scope = createScope(ctx, agent)
agent.ctx = scope.ctx
const signal = new AbortController().signal
const run = (name, args = {}) => ctx.tools.get(name, agent).execute(args, { agent, signal })
const definition = serverName => ({ transport: 'stdio', serverName, command: process.execPath, args: [fake] })
const add = (id, config, disabled = true) => loader.create({ id, name: '@deepseek-ai/dsh-mcp-client', disabled, config })
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const eventually = async predicate => {
  const end = Date.now() + 3000
  while (!(await predicate())) {
    assert.ok(Date.now() < end, 'lifecycle did not settle within 3 seconds')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
let passed = 0
const ok = text => { passed++; console.log('PASS', text) }
try {
  apply(ctx, { cacheFile })
  assert.match(await run('mcp_catalog'), /No on-demand MCP servers/)
  ok('empty DSH Loader starts without a separate connection file')

  await add('managed', definition('demo'))
  await add('official', definition('official'), false)
  await add('remote', { transport: 'streamable-http', serverName: 'remote', url: 'https://example.invalid/mcp' })
  const first = await run('mcp_catalog')
  assert.match(first, /demo: on-demand managed/)
  assert.match(first, /official: official client enabled; not managed here/)
  assert.match(first, /remote: unsupported transport/)
  await assert.rejects(run('mcp_load', { server: 'official' }), /Unknown MCP/)
  assert.equal(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__')).length, 0)
  ok('native discovery lists all Host MCP rows without duplicating enabled clients or HTTP servers')

  const entry = loader.resolve('managed')
  await entry.update({ config: { ...definition('demo'), env: { TEST_VALUE: { __jsExpr: "'resolved-by-loader'" } } } })
  await run('mcp_load', { server: 'demo' })
  const pid = JSON.parse(await run('mcp__demo__identity')).pid
  assert.ok(alive(pid))
  assert.equal(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__demo__')).length, 4)
  ok('actual Loader evaluates expression nodes before demand-start and scoped registration')

  // The root loader enumerates nested include trees, not only a profile patch.
  class MemoryTree extends EntryTree { write() {} }
  const tree = new MemoryTree(entry.ctx)
  tree.root.data = []
  await tree.create({ id: 'nested', name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: definition('nested') })
  assert.doesNotMatch(await run('mcp_catalog'), /nested: on-demand managed/)
  ok('disabled parent entries cannot revive nested MCP definitions')

  loader.remove('managed')
  // No management call: the actual loader partial-dispose event triggers retirement.
  await eventually(() => !ctx.tools.get('mcp__demo__identity', agent))
  await eventually(() => !alive(pid))
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'))
  assert.equal(cache.servers.demo, undefined)
  ok('removing a Loader entry revokes tools, metadata and its final process without a catalog call')

  // Remove all remaining entries, then add a service again.
  loader.remove('official')
  loader.remove('remote')
  await run('mcp_catalog')
  assert.match(await run('mcp_catalog'), /No on-demand MCP servers/)
  await add('last', definition('last'))
  await run('mcp_load', { server: 'last' })
  const lastPid = JSON.parse(await run('mcp__last__identity')).pid
  await loader.resolve('last').update({ disabled: false })
  ctx.emit('loader/config-update')
  await eventually(() => !alive(lastPid))
  assert.match(await run('mcp_catalog'), /last: official client enabled/)
  ok('last service can be removed and native re-enablement retires the managed connection')
  console.log(JSON.stringify({ passed }))
} finally {
  ctx.emit('dispose')
  await scope.dispose()
  const resolved = await realpath(temp)
  assert.equal(dirname(resolved), await realpath(tmpdir()))
  assert.ok(basename(resolved).startsWith('dsh-profile-lifecycle-'))
  await rm(resolved, { recursive: true, force: true })
}
