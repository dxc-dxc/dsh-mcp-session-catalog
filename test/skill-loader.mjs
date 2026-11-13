import assert from 'node:assert/strict'
import { test } from 'node:test'
import Module from 'node:module'
import { join, dirname, basename } from 'node:path'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as loader from '../skill-loader.mjs'

// Same installed-runtime import boundary as hub-harness; do not import that
// harness because it also mounts the unrelated MCP implementation under test.
const moduleRoot = process.env.DSH_TEST_MODULE_ROOT
if (!moduleRoot) throw new Error('Set DSH_TEST_MODULE_ROOT to the target DSH @deepseek-ai directory')
const dshImport = path => import(pathToFileURL(join(moduleRoot, path)).href)
const { Context, Service } = await dshImport('cordis/lib/index.js')
const { default: SystemPrompt } = await dshImport('dsh-system-prompt/lib/index.js')
const { default: Tools, defineTool } = await dshImport('dsh-tools/lib/index.js')
const { default: Skills, isSkillName, renderSkillContent } = await dshImport('dsh-skill/lib/index.js')
const { default: Agents } = await dshImport('dsh-agent/lib/index.js')
const { createScope, scopeTarget } = await dshImport('dsh-scope/lib/index.js')
const { createUserMessage } = await dshImport('dsh-llm/lib/index.js')
const official = await dshImport('dsh-tool-skill/lib/index.js')
const native = await dshImport('dsh-tool-executor-native/lib/index.js')
const helpers = { defineTool, isSkillName, renderSkillContent }
const visible = Object.freeze({ modelInvocable: true, userInvocable: true })
const hidden = Object.freeze({ modelInvocable: false, userInvocable: true })
const disabled = Object.freeze({ modelInvocable: false, userInvocable: false })
const definition = (name, extra = {}) => ({
  name, description: `Description of ${name}`, content: `# ${name}\nKeep <body> & whitespace.\n`,
  source: 'fixture', provider: 'fixture', invocation: visible, ...extra,
})

async function harness(t, { mount = true } = {}) {
  const ctx = new Context(), scopes = [], fibers = [], cwdCalls = []
  new SystemPrompt(ctx, {})
  new Tools(ctx)
  new Skills(ctx)
  new Agents(ctx)
  native.apply(ctx)
  // Only the workingDirectory boundary and session history are fixtures.
  // Registry, provider selection, scope inheritance, tools, renderer, and
  // official catalog / gesture listeners all run installed production code.
  class WorkingDirectory extends Service {
    constructor(context) { super(context, 'workingDirectory') }
    async ensure(agent, signal) {
      cwdCalls.push({ agent, signal })
      signal?.throwIfAborted()
      return agent.cwd
    }
  }
  new WorkingDirectory(ctx)
  const h = {
    ctx, cwdCalls, signal: new AbortController().signal,
    async mount(plugin = loader.createSkillLoader(helpers), context = ctx) {
      const fiber = await context.plugin(plugin)
      fibers.push(fiber)
      return fiber
    },
    agent(id, parent) {
      const agent = { id, cwd: `/fixture/${id}`, session: { seq: 0, surface: { nodes: [] } } }
      const scope = createScope(ctx, agent, parent ? { parent } : undefined)
      agent.ctx = scope.ctx
      scopes.push(scope)
      return { agent, scope }
    },
    tool(agent, name = 'skill_load') {
      const tool = ctx.tools.get(name, agent)
      assert.ok(tool, `Missing ${name}`)
      return tool
    },
    run(agent, name, signal = h.signal, toolName = 'skill_load') {
      return h.tool(agent, toolName).execute({ name }, { agent, signal })
    },
    preStep(agent, messages = []) {
      return ctx.waterfall(scopeTarget(ctx, agent), 'agent/pre-step',
        { agent, messages, signal: h.signal },
        () => ({ kind: 'continue', messages, startsRequestSeries: true }))
    },
    provider(context, { name = 'fixture-provider', skills, get, list }) {
      const trace = { lists: [], gets: [] }
      let control
      const dispose = context.skills.registerProvider(lifecycle => {
        control = lifecycle
        return {
          name,
          async list(options) {
            trace.lists.push(options)
            return list ? list(options) : skills.map((skill, index) => ({
              ...skill, provider: name, rank: 100, locator: index,
            }))
          },
          async get(candidate, options) {
            trace.gets.push({ candidate, options })
            return get ? get(candidate, options) : { ...skills[candidate.locator], provider: name }
          },
        }
      })
      return { trace, control, dispose }
    },
  }
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    for (const scope of scopes.reverse()) await scope.dispose()
    ctx.emit('dispose')
  })
  if (mount) await h.mount()
  return h
}

test('hidden loads leave the official catalog filter and invocation metadata unchanged', { timeout: 5000 }, async t => {
  const h = await harness(t, { mount: false })
  const { agent } = h.agent('catalog')
  const secret = Object.freeze(definition('hidden-skill', { invocation: hidden }))
  h.ctx.skills.register(secret)
  h.ctx.skills.register(definition('visible-skill'))
  await h.mount(official)
  const originalTool = h.tool(agent, 'skill')
  const before = await h.preStep(agent)
  await h.mount()
  const lookup = { cwd: agent.cwd, scope: agent, signal: h.signal }
  const summariesBefore = structuredClone(await h.ctx.skills.list(lookup))
  const output = await h.run(agent, 'hidden-skill')
  assert.equal(output.content, secret.content)
  assert.equal(h.tool(agent, 'skill'), originalTool)
  await assert.rejects(h.run(agent, 'hidden-skill', h.signal, 'skill'), /not available for model invocation/)
  assert.deepEqual(await h.ctx.skills.list(lookup), summariesBefore)
  assert.deepEqual(secret.invocation, hidden)
  const after = await h.preStep(agent)
  const catalog = result => result.messages.find(m => m.source.kind === 'skill-catalog')
  assert.deepEqual(catalog(before).source.entries.map(s => s.name), ['visible-skill'])
  assert.deepEqual(catalog(after).source, catalog(before).source)
  assert.deepEqual(catalog(after).content, catalog(before).content)
  assert.equal(after.messages.length, before.messages.length)
  assert.equal(after.startsRequestSeries, true)
})

for (const [kind, resourceBase] of [
  ['directory', { kind: 'directory', path: '/fixture/资料 & <examples>' }],
  ['url', { kind: 'url', url: 'https://example.invalid/skills/?a=1&b=2' }],
  ['opaque', { kind: 'opaque', description: 'provider <reference> & resource' }],
  ['absent', undefined],
]) {
  test(`visible ${kind} output, schema and rendering equal the official skill tool`, { timeout: 5000 }, async t => {
    const h = await harness(t)
    const { agent } = h.agent(kind)
    await h.mount(official)
    const skill = definition(`resource-${kind}`, {
      provider: 'test<&>provider', ...(resourceBase ? { resourceBase: Object.freeze(resourceBase) } : {}),
    })
    h.ctx.skills.register(skill)
    const output = await h.run(agent, skill.name)
    const canonical = await h.run(agent, skill.name, h.signal, 'skill')
    const ours = h.tool(agent), upstream = h.tool(agent, 'skill')
    assert.deepEqual(output, canonical)
    assert.deepEqual(ours.output.schema, upstream.output.schema)
    assert.deepEqual(ours.output.render({ name: skill.name }, output), upstream.output.render({ name: skill.name }, canonical))
    assert.equal(ours.output.render({}, output)[0].text, renderSkillContent(skill))
    assert.deepEqual(Object.keys(output).sort(), resourceBase
      ? ['content', 'name', 'provider', 'resourceBase'] : ['content', 'name', 'provider'])
    if (resourceBase) assert.notEqual(output.resourceBase, resourceBase)
  })
}

test('official /name entry still loads hidden skills and ignores non-user sources', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('gesture')
  h.ctx.skills.register(definition('hidden-skill', { invocation: hidden }))
  await h.mount(official)
  const message = createUserMessage({ content: [{ type: 'text', text: '/hidden-skill do work' }], source: { kind: 'user' } })
  const result = await h.preStep(agent, [message])
  const injections = result.messages.filter(m => m.source.kind === 'skill-invocation')
  assert.equal(injections.length, 1)
  const output = await h.run(agent, 'hidden-skill')
  assert.deepEqual(injections[0].content, h.tool(agent).output.render({}, output))
  assert.equal(result.messages[0], message)
  const external = { ...message, source: { kind: 'external' } }
  assert.deepEqual((await h.preStep(agent, [external])).messages, [external])
})

test('agent scopes isolate skills, and nearest scope wins over higher-ranked ancestors', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent: a, scope: scopeA } = h.agent('a')
  const { agent: b } = h.agent('b')
  const { agent: child } = h.agent('child', a)
  h.provider(h.ctx, { skills: [definition('shared', { content: 'global project' })] })
  a.ctx.skills.register(definition('shared', { content: 'a runtime' }))
  a.ctx.skills.register(definition('only-a', { invocation: hidden }))
  b.ctx.skills.register(definition('shared', { content: 'b runtime' }))
  assert.equal((await h.run(a, 'shared')).content, 'a runtime')
  assert.equal((await h.run(b, 'shared')).content, 'b runtime')
  assert.equal((await h.run(child, 'shared')).content, 'a runtime')
  await assert.rejects(h.run(b, 'only-a'), /unknown or no longer available/)
  await assert.rejects(h.run(undefined, 'only-a'), /requires a calling agent/)
  await scopeA.dispose()
  assert.equal((await h.run(child, 'shared')).content, 'global project')
  await assert.rejects(h.run(child, 'only-a'), /unknown or no longer available/)
})

test('same-layer provider rank outranks runtime; disposal reveals the next winner', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('rank')
  const dropRuntime = h.ctx.skills.register(definition('shared', { content: 'runtime' }))
  const user = definition('shared', { content: 'user', provider: 'user' })
  h.provider(h.ctx, { name: 'user', list: () => [{ ...user, rank: 500, locator: user }], get: c => c.locator })
  const project = h.provider(h.ctx, { skills: [definition('shared', { content: 'project' })] })
  assert.equal((await h.run(agent, 'shared')).content, 'project')
  await project.dispose()
  assert.equal((await h.run(agent, 'shared')).content, 'runtime')
  await dropRuntime()
  assert.equal((await h.run(agent, 'shared')).content, 'user')
})

test('disabled scoped winner does not fall back to an enabled global skill', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('blocked-shadow')
  h.ctx.skills.register(definition('shared'))
  agent.ctx.skills.register(definition('shared', { invocation: disabled }))
  await assert.rejects(h.run(agent, 'shared'), /disabled for both/)
})

test('loading produces a tool result without adding pre-step messages', { timeout: 5000 }, async t => {
  const h = await harness(t, { mount: false })
  const { agent } = h.agent('no-injection')
  h.ctx.skills.register(definition('hidden-skill', { invocation: hidden }))
  const before = await h.preStep(agent)
  await h.mount()
  await h.run(agent, 'hidden-skill')
  assert.deepEqual(await h.preStep(agent), before)
  assert.deepEqual(before.messages, [])
})

test('cwd, scope and signal are forwarded; changing cwd reloads provider content', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('cwd')
  const skill = definition('workspace-skill')
  let version = 0
  const p = h.provider(h.ctx, {
    skills: [skill], get: (_candidate, options) => ({ ...skill, content: `${options.cwd}:${++version}` }),
  })
  assert.equal((await h.run(agent, skill.name)).content, '/fixture/cwd:1')
  assert.equal((await h.run(agent, skill.name)).content, '/fixture/cwd:2')
  agent.cwd = '/fixture/changed'
  assert.equal((await h.run(agent, skill.name)).content, '/fixture/changed:3')
  assert.equal(h.cwdCalls.length, 3)
  for (const call of h.cwdCalls) { assert.equal(call.agent, agent); assert.equal(call.signal, h.signal) }
  assert.deepEqual(p.trace.lists.map(o => o.cwd), ['/fixture/cwd', '/fixture/changed'])
  assert.deepEqual(p.trace.gets.map(g => g.options.cwd), ['/fixture/cwd', '/fixture/cwd', '/fixture/changed'])
  for (const options of [...p.trace.lists, ...p.trace.gets.map(g => g.options)]) {
    assert.equal(options.scope, agent)
    assert.equal(options.signal, h.signal)
  }
})

test('invalid, unknown, no-agent and summary-disabled calls reject before loading', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('reject')
  const p = h.provider(h.ctx, { skills: [definition('disabled', { invocation: disabled })] })
  for (const name of ['', '../escape', 'Bad_Name', '/hidden', 'two words']) {
    await assert.rejects(h.run(agent, name), /invalid skill name/)
  }
  for (const args of [{}, { name: 5 }, { name: null }]) {
    await assert.rejects(h.tool(agent).execute(args, { agent, signal: h.signal }))
  }
  for (const agent of [undefined, null]) await assert.rejects(h.run(agent, 'disabled'), /requires a calling agent/)
  assert.equal(h.cwdCalls.length, 0)
  assert.equal(p.trace.lists.length, 0)
  await assert.rejects(h.run(agent, 'unknown'), /unknown or no longer available/)
  await assert.rejects(h.run(agent, 'disabled'), /disabled for both/)
  assert.equal(p.trace.gets.length, 0)
})

test('loaded definition rechecks invocation and disappearance; model-only remains allowed', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('reload')
  const skills = ['turned-off', 'vanished', 'model-only'].map(name => definition(name, { invocation: hidden }))
  const p = h.provider(h.ctx, { skills, get: c => c.name === 'vanished' ? undefined
    : definition(c.name, { invocation: c.name === 'turned-off' ? disabled : { modelInvocable: true, userInvocable: false } }) })
  await assert.rejects(h.run(agent, 'turned-off'), /disabled for both/)
  await assert.rejects(h.run(agent, 'vanished'), /unknown or no longer available/)
  assert.equal((await h.run(agent, 'model-only')).name, 'model-only')
  assert.equal(p.trace.gets.length, 3)
})

test('pre-cancelled calls and cwd failures propagate without provider access', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('cancelled')
  const p = h.provider(h.ctx, { skills: [definition('slow')] })
  const controller = new AbortController(), reason = new Error('cancelled before cwd')
  controller.abort(reason)
  await assert.rejects(h.run(agent, 'slow', controller.signal), error => error === reason)
  const failure = new Error('working directory unavailable')
  Object.defineProperty(agent, 'cwd', { get() { throw failure } })
  await assert.rejects(h.run(agent, 'slow'), error => error === failure)
  assert.equal(p.trace.lists.length, 0)
  assert.equal(p.trace.gets.length, 0)
})

for (const phase of ['list', 'get']) {
  test(`cancellation during provider ${phase} aborts an uncooperative provider`, { timeout: 5000 }, async t => {
    const h = await harness(t)
    const { agent } = h.agent(`cancel-${phase}`)
    const controller = new AbortController(), reason = new Error(`cancel ${phase}`)
    let entered
    const started = new Promise(resolve => { entered = resolve })
    const never = options => { assert.equal(options.signal, controller.signal); entered(); return new Promise(() => {}) }
    h.provider(h.ctx, { skills: [definition('slow')],
      ...(phase === 'list' ? { list: never } : { get: (_candidate, options) => never(options) }),
    })
    const pending = h.run(agent, 'slow', controller.signal)
    const rejected = assert.rejects(pending, error => error === reason)
    await started
    controller.abort(reason)
    await rejected
  })
}

test('plugin and provider unload remove registrations while preserving official skill and /name', { timeout: 5000 }, async t => {
  const h = await harness(t, { mount: false })
  const { agent } = h.agent('unload')
  await h.mount(official)
  const original = h.tool(agent, 'skill')
  const fiber = await h.mount()
  const skill = definition('hidden-skill', { invocation: hidden })
  let provider
  const providerFiber = await h.mount({ apply(ctx) { provider = h.provider(ctx, { skills: [skill] }) } })
  await h.run(agent, skill.name)
  await providerFiber.dispose()
  assert.equal(provider.control.signal.aborted, true)
  await assert.rejects(h.run(agent, skill.name), /unknown or no longer available/)
  h.ctx.skills.register(skill)
  await fiber.dispose()
  assert.equal(h.ctx.tools.get('skill_load', agent), undefined)
  assert.equal(h.ctx.tools.schemas(agent).some(t => t.name === 'skill_load'), false)
  assert.equal(h.tool(agent, 'skill'), original)
  const message = createUserMessage({ content: [{ type: 'text', text: '/hidden-skill' }], source: { kind: 'user' } })
  assert.equal((await h.preStep(agent, [message])).messages.filter(m => m.source.kind === 'skill-invocation').length, 1)
  await h.mount()
  assert.equal((await h.run(agent, skill.name)).content, skill.content)
})

test('scoped plugin unload does not remove another agent registration', { timeout: 5000 }, async t => {
  const h = await harness(t, { mount: false })
  const { agent: a, scope: scopeA } = h.agent('tool-a')
  const { agent: b } = h.agent('tool-b')
  h.ctx.skills.register(definition('shared'))
  await h.mount(loader.createSkillLoader(helpers), a.ctx)
  await h.mount(loader.createSkillLoader(helpers), b.ctx)
  assert.equal(h.ctx.tools.get('skill_load'), undefined)
  await scopeA.dispose()
  assert.equal(h.ctx.tools.get('skill_load', a), undefined)
  assert.equal((await h.run(b, 'shared')).name, 'shared')
})

test('real filesystem provider parses hidden frontmatter and reloads body without catalog changes', { timeout: 5000 }, async t => {
  const h = await harness(t)
  const { agent } = h.agent('filesystem')
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-loader-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(dirname(target), await realpath(tmpdir()))
    assert.ok(basename(target).startsWith('dsh-skill-loader-'))
    await rm(target, { recursive: true, force: true })
  })
  const directory = join(root, 'hidden-fixture')
  await mkdir(directory)
  const file = join(directory, 'SKILL.md')
  const frontmatter = '---\nname: hidden-fixture\ndescription: Hidden filesystem fixture\ndisable-model-invocation: true\n---\n'
  await writeFile(file, frontmatter + '# Original instructions\nSee references/example.md.\n')
  const filesystem = await dshImport('dsh-skill-filesystem/lib/index.js')
  await h.mount({ apply(ctx) { filesystem.apply(ctx, { includeDefaultRoots: false, customSkillDirs: [root], watch: false }) } })
  await h.mount(official)
  const before = await h.preStep(agent)
  assert.ok(!before.messages.some(m => m.source.kind === 'skill-catalog' && m.source.entries.some(s => s.name === 'hidden-fixture')))
  const output = await h.run(agent, 'hidden-fixture')
  assert.equal(output.content, '# Original instructions\nSee references/example.md.')
  assert.deepEqual(output.resourceBase, { kind: 'directory', path: directory })
  assert.ok(!output.content.includes('disable-model-invocation'))
  assert.equal(h.tool(agent).output.render({}, output)[0].text, renderSkillContent(output))
  await assert.rejects(h.run(agent, 'hidden-fixture', h.signal, 'skill'), /not available for model invocation/)
  await writeFile(file, frontmatter + '# Updated instructions\n')
  assert.equal((await h.run(agent, 'hidden-fixture')).content, '# Updated instructions')
  assert.deepEqual(await h.preStep(agent), before)
})

test('entry stays inert with a warning when the installed Harness lacks the official helpers', { timeout: 5000 }, async t => {
  const h = await harness(t, { mount: false })
  const { agent } = h.agent('degraded')
  h.ctx.skills.register(definition('hidden-skill', { invocation: hidden }))
  const warnings = []
  h.ctx.logger = { warn: message => warnings.push(message) }
  // Simulate an older Harness whose tool package has no official factory: the
  // anchor is the installation manifest, so that is the parent to fail.
  const anchor = join(process.env.DSH_INSTALL_DIR, 'package.json')
  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function (specifier, parent, ...rest) {
    if (parent?.filename === anchor && specifier === '@deepseek-ai/dsh-tools') {
      const error = new Error('fixture: older Harness has no official tool factory')
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    return originalResolve.call(this, specifier, parent, ...rest)
  }
  try { await h.mount(loader) } finally { Module._resolveFilename = originalResolve }
  assert.equal(h.ctx.tools.get('skill_load', agent), undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /skill_load is unavailable/)
  // The official skill tool is a separate registration and must be unaffected.
  await h.mount(official)
  assert.ok(h.tool(agent, 'skill'))
})

test('default entry resolves real helpers and native Tools execution returns canonical content', { timeout: 5000 }, async t => {
  assert.deepEqual(loader.inject, ['tools', 'skills', 'workingDirectory'])
  assert.ok(process.env.DSH_INSTALL_DIR, 'Set DSH_INSTALL_DIR to the installed @deepseek-ai/dsh package for the resolver test')
  const h = await harness(t, { mount: false })
  const { agent } = h.agent('native')
  await h.mount(loader)
  const skill = definition('hidden-skill', { invocation: hidden })
  h.ctx.skills.register(skill)
  const batch = await h.ctx.tools.execute({ agent, signal: h.signal,
    calls: [{ id: 'skill-loader-test', name: 'skill_load', arguments: JSON.stringify({ name: skill.name }) }],
  })
  assert.equal(batch.results.length, 1)
  assert.equal(batch.results[0].result.isError, false)
  assert.deepEqual(batch.results[0].result.content, [{ type: 'text', text: renderSkillContent(skill) }])
})

test('default entry uses the installation anchor without consulting stale workspace packages', { timeout: 5000 }, async t => {
  const h = await harness(t, { mount: false })
  const { agent } = h.agent('asar-fallback')
  const originalResolve = Module._resolveFilename
  const attempts = []
  // A workspace dependency must never shadow the explicit Host installation.
  // Interception records only the anchor each official import resolves from.
  Module._resolveFilename = function (specifier, parent, ...rest) {
    if (['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools'].includes(specifier)) {
      attempts.push({ specifier, anchor: parent?.filename })
    }
    return originalResolve.call(this, specifier, parent, ...rest)
  }
  try { await h.mount(loader) } finally { Module._resolveFilename = originalResolve }
  const skill = definition('hidden-skill', { invocation: hidden })
  h.ctx.skills.register(skill)
  const output = await h.run(agent, skill.name)
  assert.deepEqual(h.tool(agent).output.render({}, output), [{ type: 'text', text: renderSkillContent(skill) }])
  for (const specifier of ['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools']) {
    assert.deepEqual(attempts.filter(a => a.specifier === specifier).map(a => a.anchor), [
      join(process.env.DSH_INSTALL_DIR, 'package.json'),
    ])
  }
})
