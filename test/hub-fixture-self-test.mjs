import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { moduleRoot } from './hub-harness.mjs'
import { createFakeHub, hubTool, deadline } from './hub-fixture.mjs'
const require = createRequire(join(moduleRoot, 'dsh-mcp-client/package.json'))
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
let passed = 0
for (const responseMode of ['json', 'sse']) {
  const token = 'Bearer fixture-auth'
  const hub = await createFakeHub({ responseMode, authorization: token, pageSize: 1, tools: [hubTool('obsidian__identity'), hubTool('github__identity')], call: (_name, _args, { count }) => ({ rpcError: { code: -32603, message: `write_attempt=${count}` } }) })
  const client = new Client({ name: 'fixture-self-test', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  try {
    assert.equal(hub.counters.requests, 0)
    const denied = await fetch(hub.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) })
    assert.equal(denied.status, 401); assert.equal(hub.counters.rejectedAuth, 1)
    await client.connect(new StreamableHTTPClientTransport(new URL(hub.url), { requestInit: { headers: { Authorization: token } } }))
    const list = await client.listTools()
    assert.deepEqual(list.tools.map(t => t.name), ['obsidian__identity', 'github__identity'])
    assert.equal(hub.counters.list, 2)
    const gate = hub.hold('call:obsidian__identity')
    const call = client.callTool({ name: 'obsidian__identity', arguments: {} }).then(() => null, e => e)
    await deadline(gate.entered, 'delayed fake Hub call')
    assert.equal(hub.calls.get('obsidian__identity'), 1)
    gate.release(); assert.ok(await call)
    assert.equal(hub.calls.get('obsidian__identity'), 1)
    await client.close()
    assert.equal(hub.counters.delete, 0)
    console.log('PASS', `fake Hub ${responseMode}: SDK2 JSON/SSE auth pagination counters delay and write-attempt evidence`); passed++
  } finally { await client.close(); await hub.close() }
}
console.log(JSON.stringify({ suite: 'hub-fixture-self-test', passed }))
