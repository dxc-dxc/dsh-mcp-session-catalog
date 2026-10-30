import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { traceEvent } from './hub-fixture.mjs'

export const moduleRoot = process.env.DSH_TEST_MODULE_ROOT
if (!moduleRoot) throw new Error('Set DSH_TEST_MODULE_ROOT to the target DSH @deepseek-ai directory')
export const dshImport = path => import(pathToFileURL(join(moduleRoot, path)).href)
export const { Context, Service } = await dshImport('cordis/lib/index.js')
const { default: SystemPrompt } = await dshImport('dsh-system-prompt/lib/index.js')
const { default: Tools } = await dshImport('dsh-tools/lib/index.js')
const { default: Agents } = await dshImport('dsh-agent/lib/index.js')
const { default: Loader } = await dshImport('cordis-plugin-loader/lib/index.js')
const { createScope } = await dshImport('dsh-scope/lib/index.js')
export const actualMcpClient = await dshImport('dsh-mcp-client/lib/index.js')
export const { apply } = await import('../index.mjs')
export const plainOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
export const fakeStdio = fileURLToPath(new URL('./traced-stdio.mjs', import.meta.url))

export async function tempArea(label = 'contract') {
  const path = await mkdtemp(join(tmpdir(), `mcp-hub-${label}-`))
  const ownershipDir = join(path, 'ownership'), libraryFile = join(path, 'library.json')
  await mkdir(ownershipDir)
  const definition = (name, extra = {}) => ({ name, transport: 'stdio', command: process.execPath, args: [fakeStdio], env: {}, agents: ['dsh'], disabledTools: [], ...extra })
  return {
    path, libraryFile, ownershipDir, definition,
    async library(names, extra = {}) { await writeFile(libraryFile, JSON.stringify({ mcpHub: true, mcp: names.map(n => typeof n === 'string' ? definition(n) : n), ...extra })) },
    config(url, extra = {}) { return { cacheFile: join(path, 'cache.json'), magpieHub: { enabled: true, libraryFile, ownershipDir, ...(url ? { url } : {}), ...extra } } },
    async cache() { try { return await readFile(join(path, 'cache.json'), 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } },
    async cleanup() { const target = await realpath(path); assert.equal(dirname(target), await realpath(tmpdir())); assert.ok(basename(target).startsWith(`mcp-hub-${label}-`)); await rm(target, { recursive: true, force: true }) },
  }
}

export function harness(options = {}) {
  const ctx = new Context(), scopes = [], detaches = [], agents = [], trace = []
  new SystemPrompt(ctx, {}); new Tools(ctx); new Agents(ctx)
  const loader = new Loader(ctx); loader.root.data = []
  // Test modules stand in for backend activity; the Loader and entry lifecycles are real.
  loader.import = options.loaderImport ?? (async spec => spec === '@deepseek-ai/dsh-mcp-client' ? { ...actualMcpClient, apply() {} } : { apply() {} })
  ctx.on('tools/change', () => { const e = traceEvent(options.traceFile, { source: options.hostName ?? 'host', event: 'tools/change', global: ctx.tools.schemas().map(t => t.name) }); trace.push(e) })
  const signal = new AbortController().signal
  let sequence = 0
  return {
    ctx, loader, signal, agents, trace,
    async agent(id, source = 'startup') {
      const a = { id, session: { id }, status: 'idle' }, scope = createScope(ctx, a); a.ctx = scope.ctx; scopes.push(scope); agents.push(a)
      const detach = ctx.agents.enter(a, undefined); detaches.push(detach)
      await ctx.agents.announce(a, source)
      return a
    },
    run(agent, name, args = {}, sig = signal) { const tool = ctx.tools.get(name, agent); assert.ok(tool, `Missing public tool ${name}`); return tool.execute(args, { agent, signal: sig }) },
    dispatch(agent, name, args = {}, sig = signal) { return ctx.tools.execute({ agent, name, arguments: args, signal: sig, callId: `hub-test-${++sequence}` }) },
    schemas(agent) { return ctx.tools.schemas(agent).filter(t => t.name.startsWith('mcp__')) },
    addEntry(id, config, disabled = true) { return loader.create({ id, name: '@deepseek-ai/dsh-mcp-client', disabled, config }) },
    async close() { ctx.emit('dispose'); for (const detach of detaches.reverse()) detach(); for (const s of scopes.reverse()) await s.dispose(); await loader.root.stop?.() },
  }
}
export function endTurns(h, agent, count, start = 1) { for (let turn = start; turn < start + count; turn++) h.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }) }
export function textOf(result) { return typeof result === 'string' ? result : result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? JSON.stringify(result) }
export function nativeName(h, agent, suffix, group = 'obsidian') {
  const matches = h.schemas(agent).filter(t => t.name.includes(group) && t.name.endsWith(suffix))
  assert.equal(matches.length, 1, `Expected one ${group}/${suffix} native tool; got ${h.schemas(agent).map(t => t.name)}`)
  return matches[0].name
}
