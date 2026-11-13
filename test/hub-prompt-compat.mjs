import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureHubGate } from '../hub-gate.mjs'

const base = process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the target DSH @deepseek-ai directory')
const load = name => import(pathToFileURL(join(base, `${name}/lib/index.js`)).href)
const { Context } = await load('cordis')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { default: Tools } = await load('dsh-tools')
const { default: Agents } = await load('dsh-agent')
const { createScope } = await load('dsh-scope')
let passed = 0

async function host(run) {
  const ctx = new Context(), scopes = [], detaches = []
  new SystemPrompt(ctx, {}); new Tools(ctx); new Agents(ctx)
  if (typeof ctx.tools.setExecutor === 'function') (await load('dsh-tool-executor-native')).apply(ctx)
  const gate = ensureHubGate(ctx)
  const agent = { id: 'compat', session: { id: 'compat' }, status: 'idle' }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; scopes.push(scope)
  detaches.push(ctx.agents.enter(agent, undefined))
  await ctx.agents.announce(agent, 'startup')
  const signal = new AbortController().signal
  try { await run({ ctx, gate, agent, signal }); passed++ }
  finally { ctx.emit('dispose'); for (const off of detaches) off(); for (const s of scopes) await s.dispose() }
}
const definition = name => ({
  name, description: 'Offline fixture', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => 'offline',
})

await host(async ({ ctx, agent }) => {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  assert.ok(Array.isArray(assembly.tools))
  console.log('PASS real prompt assembly succeeds with the Host gate installed')
})
await host(async ({ ctx, agent, gate }) => {
  gate.addNamespaces(['fixture'])
  agent.ctx.tools.register(definition('mcp__fixture__unleased'))
  await assert.rejects(ctx.systemPrompt.assemble({ scope: agent }), /not loaded|mcp_load lease/)
  console.log('PASS unleased own-scope native tool is rejected during assembly')
})
await host(async ({ ctx, agent, gate, signal }) => {
  gate.addNamespaces(['fixture'])
  const name = 'mcp__fixture__leased'
  agent.ctx.tools.register(definition(name))
  let valid = true
  gate.authorize(agent, ctx.tools.get(name, agent), () => valid)
  assert.ok((await ctx.systemPrompt.assemble({ scope: agent })).tools.some(t => t.name === name))
  valid = false
  await assert.rejects(ctx.systemPrompt.assemble({ scope: agent }), /not loaded|retired/)
  const result = typeof ctx.tools.resolve === 'function'
    ? (await ctx.tools.execute({ agent, signal, calls: [{ id: 'retired', name, arguments: '{}' }] })).results[0].result
    : await ctx.tools.execute({ agent, name, arguments: {}, signal, callId: 'retired' })
  assert.equal(result.isError, true)
  console.log('PASS admitted native tool works and retired lease is rejected in assembly and dispatch')
})
await host(async ({ ctx, agent, gate }) => {
  gate.addNamespaces(['fixture'])
  ctx.systemPrompt.section({ name: 'tools:sdk', text: 'mcp__fixture__injected', order: 5000 })
  await assert.rejects(ctx.systemPrompt.assemble({ scope: agent }), /Hub gate rejected PTC assembly/)
  console.log('PASS generated PTC declarations cannot bypass the lease check')
})
await host(async ({ ctx, agent, gate }) => {
  gate.addNamespaces(['fixture'])
  agent.ctx.tools.register(definition('mcp__independent__untouched'))
  assert.ok((await ctx.systemPrompt.assemble({ scope: agent })).tools.some(t => t.name === 'mcp__independent__untouched'))
  console.log('PASS independent MCP namespaces remain usable')
})
if (typeof Tools.prototype.resolve === 'function') {
  await host(async ({ ctx, agent, gate, signal }) => {
    gate.addNamespaces(['fixture'])
    agent.ctx.tools.register(definition('mcp__fixture__conditional'), { when: () => false })
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'fixture', model: 'offline' } })
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent, toolSet })
      assert.equal(assembly.tools.some(t => t.name === 'mcp__fixture__conditional'), false)
    } finally { toolSet.dispose() }
    console.log('PASS native validation respects the current step admission set')
  })
}
console.log(JSON.stringify({ suite: 'hub-prompt-compat', passed, failed: 0 }))
