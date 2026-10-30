// This gate lives on the Host root, independently of manager HMR. It only
// governs explicit Hub namespaces and the direct namespaces they supersede.
const KEY = Symbol.for('@dxc-dxc/mcp-session-catalog/hub-gate/v1')
export const name = 'mcp-hub-gate'
export const inject = ['tools', 'agents', 'systemPrompt']

class HubGate {
  constructor(ctx) {
    this.ctx = ctx
    this.namespaces = new Set()
    this.agents = new Map()
    this.wrappers = new WeakMap()
    this.closed = false
    this.syncing = false
    ctx.tools.guard(exec => this.reason(exec.agent, exec.name))
    ctx.on('agent/created', ({ agent }) => { this.attach(agent); this.sync(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.agents.delete(agent) })
    ctx.on('tools/change', () => this.syncAll())
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      const agent = context.scope
      // Assert both native schemas and generated PTC declarations. Never try to
      // wash an already accepted snapshot at agent/pre-step.
      for (const tool of assembly.tools) {
        const reason = this.reason(agent, tool.name)
        if (reason) throw new Error(reason)
      }
      for (const section of assembly.sections) {
        if (section.name !== 'tools:sdk') continue
        for (const match of section.text.matchAll(/\bmcp__[A-Za-z0-9_-]+/g)) {
          const reason = this.reason(agent, match[0])
          if (reason) throw new Error(`Hub gate rejected PTC assembly: ${reason}`)
        }
      }
      return assembly
    })
    ctx.effect(() => () => {
      this.closed = true
      for (const entry of this.agents.values()) for (const dispose of entry.disposers) dispose()
      this.agents.clear()
    }, 'mcp-hub-gate: Host lifetime')
    for (const agent of ctx.agents?.list?.() ?? []) {
      // Installing over live sessions cannot rewrite a request that is already
      // assembled; the assembly assertion and the execution guard still fail
      // closed for those. Attaching here means the next request is masked
      // instead of refusing to load the plugin at all.
      this.attach(agent)
      this.sync(agent)
    }
  }
  controls(name) {
    return [...this.namespaces].some(namespace => name.startsWith(`mcp__${namespace}__`))
  }
  reason(agent, name) {
    if (!this.controls(name)) return undefined
    if (this.closed) return 'Hub gate unavailable; controlled restart required'
    if (!agent || !this.agents.has(agent)) return 'Hub tool requires an admitted calling session and mcp_load lease'
    const definition = this.ctx.tools.get(name, agent)
    const grant = definition && this.wrappers.get(definition)
    if (!grant || grant.agent !== agent || !grant.valid()) return 'Hub tool not loaded or its source generation retired; call mcp_load again'
    return undefined
  }
  attach(agent) {
    if (this.agents.has(agent)) return
    if (!agent?.ctx?.tools) throw new Error('NEEDS_CONTEXT: Hub gate requires public agent.ctx.tools')
    this.agents.set(agent, { denied: new Set(), disposers: [], restrictions: new Map() })
  }
  addNamespaces(names) {
    for (const name of names) this.namespaces.add(name)
    this.syncAll()
  }
  removeNamespaces(names) {
    for (const name of names) this.namespaces.delete(name)
    for (const state of this.agents.values()) for (const [name, dispose] of state.restrictions) {
      if (this.controls(name)) continue
      dispose(); state.restrictions.delete(name); state.denied.delete(name)
    }
  }
  syncAll() {
    if (this.syncing || this.closed) return
    this.syncing = true
    try { for (const agent of this.agents.keys()) this.sync(agent) }
    finally { this.syncing = false }
  }
  sync(agent) {
    const state = this.agents.get(agent)
    if (!state || this.closed) return
    // Global and inherited schemas are discoverable through the public view.
    // The own-layer exemption is checked again by assembly and the guard.
    const schemas = this.ctx.tools.schemas(agent)
    for (const { name } of schemas) {
      if (!this.controls(name) || state.denied.has(name)) continue
      const definition = this.ctx.tools.get(name, agent)
      if (this.wrappers.get(definition)?.agent === agent) continue
      try {
        const dispose = agent.ctx.tools.restrict({ deny: [name] })
        state.disposers.push(dispose)
        state.denied.add(name)
        state.restrictions.set(name, dispose)
      } catch {
        // Public restrict refuses own/unknown names. Assert/guard fail closed
        // rather than touching another plugin's registration or all MCP tools.
      }
    }
  }
  authorize(agent, definition, valid) {
    this.attach(agent)
    this.wrappers.set(definition, { agent, valid })
  }
}

export function ensureHubGate(ctx) {
  const root = ctx.root ?? ctx
  const current = root[KEY]
  if (current && !current.closed) return current
  // A disposed gate is replaced rather than poisoning every later apply: an HMR
  // or rollback of the manager must not require a Host restart to regain
  // isolation. A fresh gate re-attaches live agents in its constructor.
  const gate = new HubGate(root)
  root[KEY] = gate
  return gate
}

export function apply(ctx) { ensureHubGate(ctx) }
