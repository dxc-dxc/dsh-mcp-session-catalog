import assert from 'node:assert/strict'
import { createFakeHub, hubTool } from './hub-fixture.mjs'
import { tempArea, harness, apply, nativeName, textOf, endTurns } from './hub-harness.mjs'

// Magpie's upstream hub names are '<Library name>__<backend raw tool name>'.
// Only the wire name is fixed here; native public names are discovered from schemas.
const raw = (group, tool) => `${group}__${tool}`
const definitions = () => [hubTool(raw('obsidian', 'identity')), hubTool(raw('obsidian', 'write'), { annotations: { readOnlyHint: false } }), hubTool(raw('github', 'identity'))]
let passed = 0
const ok = label => { passed++; console.log('PASS', label) }
const cases = []
const test = (name, run) => cases.push({ name, run })

async function setup(options = {}) {
  const area = await tempArea('contract')
  await area.library(options.library ?? ['obsidian', 'github'])
  const hub = await createFakeHub({ tools: definitions(), ...options.hub })
  const h = harness(), a = await h.agent('A'), b = await h.agent('B')
  apply(h.ctx, area.config(hub.url, options.config))
  return { area, hub, h, a, b, async close() { await h.close(); await hub.close(); await area.cleanup() } }
}

test('startup, catalog and resumed identities perform zero Hub network', async () => {
  const x = await setup()
  try {
    const { h, hub, a, b } = x
    assert.equal(hub.counters.requests, 0)
    const catalog = await h.run(a, 'mcp_catalog')
    assert.match(catalog, /obsidian/); assert.match(catalog, /github/)
    const resumed = await h.agent('resumed', 'resume')
    await h.run(resumed, 'mcp_catalog')
    assert.deepEqual(h.schemas(a), []); assert.deepEqual(h.schemas(b), []); assert.deepEqual(h.schemas(resumed), [])
    await h.ctx.systemPrompt.assemble({ scope: resumed, agent: resumed })
    assert.equal(hub.counters.requests, 0)
  } finally { await x.close() }
})

test('A load grants only selected group; B dispatcher rejects; refresh grants nothing', async () => {
  const x = await setup({ hub: { pageSize: 1 } })
  try {
    const { h, hub, a, b } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    assert.equal(h.schemas(a).length, 2); assert.deepEqual(h.schemas(b), [])
    assert.equal(h.schemas(a).some(t => t.name.includes('github')), false)
    const tool = nativeName(h, a, 'identity')
    const before = hub.counters.call
    assert.equal((await h.dispatch(b, tool)).isError, true)
    assert.equal(hub.counters.call, before)
    assert.equal((await h.dispatch(a, tool)).isError, false)
    assert.equal(hub.calls.get(raw('obsidian', 'identity')), 1)
    assert.ok(hub.counters.list >= 3, 'all pages must be read')
    await h.run(b, 'mcp_refresh', { server: 'obsidian' })
    assert.deepEqual(h.schemas(b), [])
    assert.equal(hub.counters.initialize, 1)
  } finally { await x.close() }
})

test('logical groups share physical transport; cancellation does not damage other callers', async () => {
  const x = await setup()
  try {
    const { h, hub, a, b } = x
    await Promise.all([h.run(a, 'mcp_load', { server: 'obsidian' }), h.run(b, 'mcp_load', { server: 'github' })])
    assert.equal(hub.counters.initialize, 1)
    const obsidian = nativeName(h, a, 'identity'), github = nativeName(h, b, 'identity', 'github')
    const gate = hub.hold(`call:${raw('obsidian', 'identity')}`), abort = new AbortController()
    const pending = h.run(a, obsidian, {}, abort.signal).then(() => null, e => e)
    await gate.entered; abort.abort(); assert.ok(await pending)
    assert.ok(textOf(await h.run(b, github)))
    gate.release()
    await h.run(a, 'mcp_load', { server: 'obsidian', action: 'unload' })
    assert.deepEqual(h.schemas(a), []); assert.equal(h.schemas(b).length, 1)
    assert.ok(textOf(await h.run(b, github)))
    await h.run(b, 'mcp_load', { server: 'github', action: 'unload' })
    assert.equal(hub.counters.delete, 0, 'local release must never terminate Magpie session/backend')
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    assert.equal(hub.counters.initialize, 2, 'final reference closes the local HTTP client')
  } finally { await x.close() }
})

test('cancelled discovery waiter and stale completion cannot resurrect a lease', async () => {
  const x = await setup()
  try {
    const { h, hub, a, b } = x
    const gate = hub.hold('list'), abort = new AbortController()
    const first = h.run(a, 'mcp_load', { server: 'obsidian' }, abort.signal).then(() => null, e => e)
    await gate.entered
    const second = h.run(b, 'mcp_load', { server: 'obsidian' })
    await new Promise(r => setTimeout(r, 25))
    abort.abort(); assert.ok(await first); gate.release(); await second
    assert.deepEqual(h.schemas(a), []); assert.equal(h.schemas(b).length, 2)
    assert.equal(hub.counters.initialize, 1)
    await h.run(b, 'mcp_load', { server: 'obsidian', action: 'unload' })
    const old = hub.hold('list')
    const pending = h.run(a, 'mcp_load', { server: 'obsidian' }).then(() => null, e => e)
    await old.entered
    await h.run(a, 'mcp_load', { server: 'obsidian', action: 'unload' })
    old.release(); assert.ok(await pending)
    assert.deepEqual(h.schemas(a), [])
  } finally { await x.close() }
})

test('20 unused turns, archive and disposal revoke only exact owners', async () => {
  const x = await setup()
  try {
    const { h, hub, a, b } = x
    await Promise.all([h.run(a, 'mcp_load', { server: 'obsidian' }), h.run(b, 'mcp_load', { server: 'obsidian' })])
    endTurns(h, a, 19); assert.equal(h.schemas(a).length, 2)
    endTurns(h, a, 1, 20); assert.deepEqual(h.schemas(a), []); assert.equal(h.schemas(b).length, 2)
    h.ctx.emit('domain/changed', { domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds: [b.id] } })
    assert.deepEqual(h.schemas(b), [])
    const c = await h.agent('C'); await h.run(c, 'mcp_load', { server: 'obsidian' })
    h.ctx.emit('agent/disposed', { agent: c }); assert.deepEqual(h.schemas(c), [])
    assert.equal(hub.counters.delete, 0)
  } finally { await x.close() }
})

test('Library additions at unchanged endpoint never broaden existing leases; deletions revoke', async () => {
  const x = await setup({ library: ['obsidian'] })
  try {
    const { h, hub, area, a, b } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    const old = h.schemas(a).map(t => t.name), url = hub.url
    await area.library(['obsidian', 'github'])
    assert.match(await h.run(a, 'mcp_catalog'), /github/)
    assert.equal(hub.url, url); assert.deepEqual(h.schemas(a).map(t => t.name), old)
    await h.run(b, 'mcp_refresh', { server: 'github' }); assert.deepEqual(h.schemas(b), [])
    await h.run(b, 'mcp_load', { server: 'github' }); assert.equal(h.schemas(b).length, 1)
    await area.library(['github'])
    await h.run(a, 'mcp_catalog')
    assert.deepEqual(h.schemas(a), [])
    assert.equal((await h.dispatch(a, old[0])).isError, true)
    await assert.rejects(h.run(a, 'mcp_load', { server: 'obsidian' }))
    assert.equal(h.schemas(b).length, 1)
  } finally { await x.close() }
})

test('disabledTools and cancelled DSH assignment revoke authorization', async () => {
  const x = await setup()
  try {
    const { h, area, a } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    const tool = nativeName(h, a, 'identity')
    await area.library([area.definition('obsidian', { disabledTools: ['identity'] }), 'github'])
    await h.run(a, 'mcp_catalog')
    assert.equal((await h.dispatch(a, tool)).isError, true)
    await area.library([area.definition('obsidian', { agents: ['other-client'] }), 'github'])
    await h.run(a, 'mcp_catalog'); assert.deepEqual(h.schemas(a), [])
  } finally { await x.close() }
})

test('SSE responses, explicit auth and structured results use the public dispatcher', async () => {
  const secret = 'Bearer fixture-secret-not-for-cache'
  const x = await setup({ config: { headers: { Authorization: secret } }, hub: { responseMode: 'sse', authorization: secret, call: () => ({ content: [{ type: 'text', text: 'structured result' }], structuredContent: { exact: 42 } }) } })
  try {
    const { h, hub, area, a } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    const result = await h.dispatch(a, nativeName(h, a, 'identity'))
    assert.equal(result.isError, false)
    assert.match(JSON.stringify(result), /42/)
    assert.equal(hub.counters.rejectedAuth, 0)
    assert.equal((await area.cache()).includes(secret), false)
    assert.equal(JSON.stringify(hub.trace).includes(secret), false)
  } finally { await x.close() }
})

test('Hub state-changing and read calls are never automatically replayed', async () => {
  const x = await setup({ hub: { call: (_name, _args, { count }) => ({ rpcError: { code: -32603, message: `ECONNRESET write_attempt=${count}` } }) } })
  try {
    const { h, hub, a } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    for (const suffix of ['write', 'identity']) {
      const result = await h.dispatch(a, nativeName(h, a, suffix))
      assert.equal(result.isError, true); assert.equal(hub.calls.get(raw('obsidian', suffix)), 1)
    }
  } finally { await x.close() }
})

test('revocation during policy/approval wait prevents a previously resolved wrapper from dispatching', async () => {
  const x = await setup()
  try {
    const { h, hub, a, area } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    const tool = nativeName(h, a, 'identity'), wrapper = h.ctx.tools.get(tool, a)
    const { deferred } = await import('./hub-fixture.mjs'), entered = deferred(), release = deferred()
    const off = h.ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === tool) { entered.resolve(); await release.promise }; return next() })
    const pending = h.dispatch(a, tool)
    await entered.promise
    await area.library(['github']); await h.run(a, 'mcp_catalog'); release.resolve()
    assert.equal((await pending).isError, true)
    await assert.rejects(wrapper.execute({}, { agent: a, signal: h.signal }))
    assert.equal(hub.calls.get(raw('obsidian', 'identity')) ?? 0, 0)
    off()
  } finally { await x.close() }
})

test('progressive Hub discovery names every backend tool and invokes through call_tool', async () => {
  // github is assigned in the Library but the Hub answers for it with prose
  // only, which is what an unavailable backend looks like on the wire.
  const catalog = {
    obsidian: [hubTool(raw('obsidian', 'identity')), hubTool(raw('obsidian', 'write'), { annotations: { readOnlyHint: false } })],
  }
  const progressive = [{ name: 'find_tools', description: 'find', inputSchema: { type: 'object', properties: {} } }, { name: 'call_tool', description: 'invoke', inputSchema: { type: 'object', properties: {} } }]
  const seen = []
  const x = await setup({
    hub: {
      tools: progressive,
      call: (tool, args) => {
        seen.push({ tool, args })
        if (tool === 'find_tools') {
          // Mirrors the real Hub: an empty query with a server names every tool of
          // that backend; a name query answers with that tool's full definition.
          if (args.server !== undefined && !args.query) {
            const found = catalog[args.server] ?? []
            return { content: [{ type: 'text', text: found.length ? `Every tool, by name; find_tools with its name gives its parameters:\n${found.map(item => `- ${item.name}: ${item.description}`).join('\n')}\n` : `No server called ${args.server} is behind this one.` }] }
          }
          const found = (catalog[args.server ?? 'obsidian'] ?? []).filter(item => item.name === args.query || item.name.includes(args.query))
          return { content: [{ type: 'text', text: found.length ? `Run one with call_tool, its name and arguments as its inputSchema says.\n${JSON.stringify(found)}` : `No tool matches "${args.query}".` }] }
        }
        if (tool === 'call_tool') return { content: [{ type: 'text', text: `ran ${args.name}` }] }
        return undefined
      },
    },
  })
  try {
    const { h, hub, a, b } = x
    await h.run(a, 'mcp_load', { server: 'obsidian' })
    assert.equal(h.schemas(a).length, 2, 'only the requested backend is granted')
    assert.equal(h.schemas(a).some(tool => tool.name.includes('github')), false)
    const result = await h.dispatch(a, nativeName(h, a, 'identity'))
    assert.equal(result.isError, false)
    assert.match(textOf(result), /ran obsidian__identity/)
    assert.deepEqual(seen.filter(row => row.tool === 'call_tool').map(row => row.args.name), [raw('obsidian', 'identity')])
    const nameQueries = seen.filter(row => row.tool === 'find_tools').map(row => row.args.query === '' ? `server:${row.args.server}` : row.args.query)
    assert.deepEqual([...new Set(nameQueries)].sort(), ['obsidian__identity', 'obsidian__write', 'server:github', 'server:obsidian'])
    assert.equal(hub.calls.get('find_tools'), 4)
    // A backend the Hub answers for with prose alone stays blocked, naming itself.
    await assert.rejects(h.run(b, 'mcp_load', { server: 'github' }), /does not currently serve this backend/i)
    assert.deepEqual(h.schemas(b), [])
  } finally { await x.close() }
})

const filter = process.env.HUB_TEST_CASE
let failures = 0
for (const { name, run } of cases.filter(c => !filter || c.name.includes(filter))) {
  try { await run(); ok(name) } catch (error) { failures++; console.error('FAIL', name, error.stack) }
}
console.log(JSON.stringify({ suite: 'hub-contract', passed, failed: failures }))
if (failures) process.exitCode = 1
