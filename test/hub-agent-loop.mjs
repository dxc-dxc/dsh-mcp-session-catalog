import assert from 'node:assert/strict'
import { join } from 'node:path'
import { harness, dshImport, plainOutput, apply, tempArea, nativeName } from './hub-harness.mjs'
import { createFakeHub, hubTool, deadline } from './hub-fixture.mjs'
const { default: SessionStore } = await dshImport('dsh-session/lib/index.js')
const { default: SessionProjections } = await dshImport('dsh-session-projection/lib/index.js')
const { default: AgentLoop } = await dshImport('dsh-agent-loop/lib/index.js')
const { LlmRuntime, LlmAdapter, createUserMessage, isAgentLoopRequest, markAgentLoopRequest } = await dshImport('dsh-llm/lib/index.js')
const { default: PtcRuntime } = await dshImport('dsh-ptc-runtime/lib/index.js')
const jsonl = await dshImport('dsh-session-persistence-jsonl/lib/index.js')

// Only execution is unused. Model-facing PTC codegen is the real Tools SDK
// generator, backed by the public runtime descriptor seam.
class DescriptorRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'process'
  resolve() { throw new Error('This suite captures assembly; it never executes arbitrary programs') }
  run() { throw new Error('PTC execution is not part of the request-assembly fixture') }
}
class CaptureAdapter extends LlmAdapter {
  requests = []
  async prepareCall(provider, model, signal) {
    const prepared = await super.prepareCall(provider, model, signal)
    return {
      model: prepared.model,
      stream: (options) => {
        markAgentLoopRequest(options)
        return this.stream(options)
      }
    }
  }
  async *stream(options) {
    assert.equal(isAgentLoopRequest(options), true, 'capture must originate in actual AgentLoop')
    this.requests.push(structuredClone({ tools: options.tools, messages: options.messages }))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'offline fixture complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline fixture complete' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function loopHarness(area, options = {}) {
  const h = harness(options), { ctx } = h
  new SessionStore(ctx); new SessionProjections(ctx); new LlmRuntime(ctx); new DescriptorRuntime(ctx)
  const adapter = new CaptureAdapter(), errors = []
  ctx.on('agent/error', event => { errors.push(event.error?.stack ?? String(event.error)) })
  ctx.llm.registerAdapter(['fixture'], adapter)
  await jsonl.apply(ctx, { root: join(area.path, 'sessions'), compression: 'none', listConcurrency: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 2 })
  const handles = [], closeHost = h.close.bind(h)
  return Object.assign(h, {
    adapter,
    async create(id, mode = 'native') {
      const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'capture' }, setup(agentCtx) { if (mode === 'ptc') agentCtx.tools.presentAs('ptc') } })
      handles.push(handle); return handle
    },
    async request(agent) {
      const before = adapter.requests.length
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Capture the first actual model request without using tools.' }], source: { kind: 'user' } }))
      await deadline(agent.whenIdle(), 'real AgentLoop idle')
      assert.equal(adapter.requests.length, before + 1, `the actual model adapter must receive exactly one request; errors=${errors.join('\n')}; tail=${JSON.stringify(agent.session.snapshotEvents().slice(-3))}`)
      return adapter.requests.at(-1)
    },
    async resume(id, mode = 'native') {
      const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'capture' }, setup(agentCtx) { if (mode === 'ptc') agentCtx.tools.presentAs('ptc') } })
      handles.push(handle); return handle
    },
    async close() { for (const handle of handles.reverse()) await handle.dispose(); await closeHost() },
  })
}
const nativeTools = request => request.tools?.filter(t => t.name.startsWith('mcp__')) ?? []
const sdkText = request => JSON.stringify(request.messages)
let passed = 0, failed = 0
async function test(label, fn) { if (process.env.HUB_TEST_CASE && !label.includes(process.env.HUB_TEST_CASE)) return; try { await fn(); passed++; console.log('PASS', label) } catch (e) { failed++; console.error('FAIL', label, e.stack) } }

if (process.argv[1]?.endsWith('hub-agent-loop.mjs')) {
  await test('actual AgentLoop fixture captures native and PTC first requests offline', async () => {
    const area = await tempArea('loop-smoke'), h = await loopHarness(area)
    try {
      const n = await h.create('smoke-native'), p = await h.create('smoke-ptc', 'ptc')
      h.ctx.tools.register({ name: 'fixture_visible', description: 'Visible non-MCP control', parameters: { type: 'object', properties: {} }, output: plainOutput, execute: async () => 'ok' })
      const nr = await h.request(n.agent), pr = await h.request(p.agent)
      assert.ok(nr.tools.some(t => t.name === 'fixture_visible'))
      assert.deepEqual(pr.tools.map(t => t.name), ['run_code'])
      assert.match(sdkText(pr), /fixture_visible/)
    } finally { await h.close(); await area.cleanup() }
  })
  for (const mode of ['native', 'ptc']) {
    await test(`actual ${mode} first request, load, B isolation and real durable resume stay lease-scoped`, async () => {
      const area = await tempArea(`loop-${mode}`)
      await area.library(['obsidian', 'github'])
      const hub = await createFakeHub({ tools: [hubTool('obsidian__identity'), hubTool('github__identity')] })
      const h = await loopHarness(area)
      try {
        apply(h.ctx, area.config(hub.url))
        const a = await h.create(`loop-A-${mode}`, mode), b = await h.create(`loop-B-${mode}`, mode)
        const firstA = await h.request(a.agent), firstB = await h.request(b.agent)
        assert.deepEqual(nativeTools(firstA), []); assert.deepEqual(nativeTools(firstB), [])
        assert.doesNotMatch(sdkText(firstA), /mcp__(?:magpie__)?obsidian__/)
        assert.equal(hub.counters.requests, 0)
        await h.run(a.agent, 'mcp_load', { server: 'obsidian' })
        const loaded = await h.request(a.agent), unrelated = await h.request(b.agent)
        const name = nativeName(h, a.agent, 'identity')
        if (mode === 'native') assert.equal(nativeTools(loaded).length, 1)
        else { assert.deepEqual(loaded.tools.map(t => t.name), ['run_code']); assert.ok(sdkText(loaded).includes(name)) }
        assert.deepEqual(nativeTools(unrelated), []); assert.equal(sdkText(unrelated).includes(name), false)
        const calls = hub.counters.call
        assert.equal((await h.dispatch(b.agent, name)).isError, true); assert.equal(hub.counters.call, calls)
        await h.ctx.sessionPersistence.flush()
        await a.dispose()
        const beforeResume = hub.counters.requests
        const resumed = await h.resume(`loop-A-${mode}`, mode)
        assert.deepEqual(h.schemas(resumed.agent), [])
        // Resuming may preserve historical messages, but current request tools and
        // current generated SDK must not authorize that historical lease.
        const assembly = await h.ctx.systemPrompt.assemble({ scope: resumed.agent, agent: resumed.agent })
        assert.deepEqual(assembly.tools.filter(t => t.name.startsWith('mcp__')), [])
        assert.equal(assembly.sections.some(s => s.name === 'tools:sdk' && s.text.includes(name)), false)
        assert.equal(hub.counters.requests, beforeResume)
      } finally { await h.close(); await hub.close(); await area.cleanup() }
    })
  }
  console.log(JSON.stringify({ suite: 'hub-agent-loop', passed, failed }))
  if (failed) process.exitCode = 1
}
