import { createHash } from 'node:crypto'
import { readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HttpConnection } from './http-connection.mjs'
import { HubOwnership } from './hub-ownership.mjs'
import { ensureHubGate } from './hub-gate.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const expand = value => value?.startsWith('~/') ? join(homedir(), value.slice(2)) : value
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const interpolate = (entry, value) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string') return entry.evaluate(value.__jsExpr)
  if (Array.isArray(value)) return value.map(item => interpolate(entry, item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(entry, item)]))
  return value
}
export function hubPublicName(server, raw) {
  const joined = `mcp__${server}__${raw}`, normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (joined === normalized && normalized.length <= 64) return joined
  const suffix = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${suffix}`
}
const hubPath = value => { try { return new URL(value).pathname.replace(/\/$/, '') === '/mcp/magpie/hub/dsh' } catch { return false } }
const prefixOf = name => `${name.replace(/[^A-Za-z0-9_-]/g, '-')}__`
const aborted = signal => { if (signal?.aborted) throw new Error('MCP call aborted') }

export class HubAdapter {
  constructor(ctx, config, hooks) {
    this.ctx = ctx
    this.config = config
    this.hooks = hooks
    this.libraryFile = resolve(expand(config.libraryFile ?? join(homedir(), '.config/magpie/library.json')))
    this.services = new Map()
    this.owned = new Set()
    this.lastKnown = new Set()
    this.leases = new Map()
    this.snapshots = new Map()
    this.closed = false
    this.error = null
    this.generation = 0
    this.physical = null
    this.reloadQueue = Promise.resolve()
    this.gate = ensureHubGate(ctx)
    this.gate.addNamespaces([config.serverName ?? 'magpie'])
    this.ownership = new HubOwnership(expand(config.ownershipDir), async (names, releasing) => { await hooks.retireDirect(names); await this.retireHub(releasing) })
    this.readLocal()
    if (this.localCandidate) this.services = this.localCandidate
    for (const name of this.services.keys()) this.owned.add(name)
    this.gate.addNamespaces([...this.owned].map(name => name.replace(/[^A-Za-z0-9_-]/g, '_')))
    this.ready = this.reload()
    this.ready.catch(() => {})
    try {
      this.watcher = watch(dirname(this.libraryFile), (_event, file) => {
        if (!file || String(file) === this.libraryFile.slice(this.libraryFile.lastIndexOf('/') + 1)) this.reload().catch(() => {})
      })
      this.watcher.unref?.()
    } catch { /* Operations re-read local metadata even without an available watcher. */ }
  }
  loader() {
    try { return this.ctx.get?.('loader') ?? this.ctx.loader } catch { return null }
  }
  entries() { return [...(this.loader()?.entries?.() ?? [])] }
  endpoint() {
    const candidates = []
    for (const entry of this.entries()) {
      if (entry.options?.name !== '@deepseek-ai/dsh-mcp-client') continue
      const source = interpolate(entry, entry.options.config)
      if (!source || source.transport !== 'streamable-http') continue
      const id = entry.id ?? entry.options.id
      const explicit = this.config.entryId && (id === this.config.entryId || entry.options.id === this.config.entryId)
      const matched = explicit || (this.config.url && source.url === this.config.url) || (!this.config.entryId && hubPath(source.url))
      if (matched) candidates.push({ entry, source })
    }
    if (this.config.entryId && !candidates.some(({ entry }) => (entry.id ?? entry.options.id) === this.config.entryId || entry.options.id === this.config.entryId)) throw new Error('Hub entryId does not resolve to the configured HTTP entry')
    const distinct = new Set(candidates.map(({ source }) => source.url))
    if (!this.config.url && distinct.size > 1) throw new Error('Multiple Hub endpoints require explicit entryId or url')
    const source = candidates[0]?.source
    const url = this.config.url ?? source?.url
    if (!url) throw new Error('Hub endpoint unavailable; configure entryId or url')
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Hub requires an HTTP URL without embedded credentials')
    const headers = this.config.headers ?? source?.headers ?? {}
    if (!headers || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string')) throw new Error('Invalid Hub headers')
    const namespaces = new Set([this.config.serverName ?? 'magpie', ...candidates.map(({ source }) => source.serverName).filter(Boolean)])
    return { server: { url, headers, serverName: this.config.serverName ?? source?.serverName ?? 'magpie', toolCallTimeoutMs: source?.toolCallTimeoutMs }, candidates, namespaces }
  }
  readLocal() {
    try {
      const library = JSON.parse(readFileSync(this.libraryFile, 'utf8'))
      if (!library || typeof library.mcpHub !== 'boolean' || !Array.isArray(library.mcp)) throw new Error('Invalid Library schema')
      const services = new Map()
      for (const row of library.mcp) {
        if (!row || typeof row.name !== 'string' || !row.name || !Array.isArray(row.agents)) throw new Error('Invalid Library server identity')
        if (!library.mcpHub || !row.agents.includes('dsh')) continue
        if (services.has(row.name)) throw new Error('Duplicate Library server identity')
        if (row.disabledTools !== undefined && (!Array.isArray(row.disabledTools) || row.disabledTools.some(value => typeof value !== 'string'))) throw new Error('Invalid Library disabled tools')
        // Store minimum routing/assignment metadata. Backend credentials and
        // command values are not copied to the catalog or ownership registry.
        services.set(row.name, { name: row.name, identity: hash({ transport: row.transport, command: row.command, args: row.args, env: row.env, cwd: row.cwd, url: row.url, headers: row.headers }), disabledTools: row.disabledTools ?? [] })
      }
      this.localCandidate = services
      this.localError = null
      // A readable Library is authoritative: its current names replace the last
      // trusted set, so a service removed from the Library is released rather
      // than blocked forever by this Host's memory of it.
      this.lastKnown = new Set(services.keys())
      this.hubOff = library.mcpHub !== true
      return
    } catch (error) {
      // An absent Library (Magpie never installed or never run) manages no
      // service, so it must not block services that were never Hub-owned.
      if (error?.code === 'ENOENT') {
        this.localCandidate = new Map()
        this.localError = null
        this.hubOff = false
        this.libraryAbsent = true
        return
      }
      this.libraryAbsent = false
      this.localCandidate = null
      this.localError = 'Hub Library unreadable or invalid; last trusted ownership retained and new startup blocked'
    }
  }
  definitions() {
    return [...this.services.values()].map(service => ({ serverName: service.name, purpose: `${service.name} (Magpie Hub; session-scoped)`, hub: true }))
  }
  owns(name) { return this.owned.has(name) || this.services.has(name) }
  assertDirect(name) {
    // Only a name this Library has actually managed (now, or in the last
    // trusted snapshot of this Host) can be Hub-owned. An unreadable Library
    // must not veto an unrelated independent stdio service: the recorded claim
    // below is the concrete authority for that name, and it survives the
    // failure precisely so a previously managed name stays blocked.
    if (this.owns(name) || this.lastKnown?.has(name)) throw new Error('Hub-owned or uncertain service cannot start directly')
    this.ownership.assertDirect(name)
  }
  reload() {
    const task = this.reloadQueue.catch(() => {}).then(() => this.reloadOnce())
    this.reloadQueue = task
    return task
  }
  async reloadOnce() {
    if (this.closed) return
    this.readLocal()
    if (!this.localCandidate) { this.error = this.localError; return }
    const next = this.localCandidate
    for (const name of next.keys()) this.owned.add(name)
    this.gate.addNamespaces([...this.owned].map(name => name.replace(/[^A-Za-z0-9_-]/g, '_')))
    // Ownership is published before any direct retirement/network can yield.
    await this.ownership.claim([...next.values()])
    const claims = this.ownership.read().claims
    const released = [...this.owned].filter(name => !next.has(name) && !claims[name])
    for (const name of released) this.owned.delete(name)
    this.gate.removeNamespaces(released.map(name => name.replace(/[^A-Za-z0-9_-]/g, '_')))
    if (this.closed) return
    let endpoint
    try { endpoint = this.endpoint() }
    catch { this.error = 'Hub endpoint missing, ambiguous, or invalid; direct fallback disabled' }
    const physicalChanged = endpoint && this.endpointKey !== hash(endpoint.server)
    if (physicalChanged || (!endpoint && this.endpointKey)) {
      this.generation++
      for (const lease of this.allLeases()) this.revoke(lease)
      await this.closePhysical()
      this.snapshots.clear()
    }
    if (endpoint) {
      this.endpointValue = endpoint
      this.endpointKey = hash(endpoint.server)
      this.gate.addNamespaces(endpoint.namespaces)
    }
    for (const lease of this.allLeases()) {
      const service = next.get(lease.server)
      if (!service || !same(service, this.services.get(lease.server))) this.revoke(lease)
    }
    for (const [name, service] of this.services) if (!same(next.get(name), service)) this.snapshots.delete(name)
    this.services = next
    if (endpoint) this.error = null
    this.hooks.changed?.()
  }
  allLeases() { return [...this.leases.values()].flatMap(map => [...map.values()]) }
  async retireOfficial() {
    // Only entry definitions explicitly selected as this Hub or duplicated by
    // its Library identities are retired. Other HTTP MCP entries are untouched.
    const endpoint = this.endpoint()
    const selected = new Set(endpoint.candidates.map(value => value.entry))
    for (const entry of this.entries()) {
      if (entry.options?.name !== '@deepseek-ai/dsh-mcp-client') continue
      let source
      try { source = interpolate(entry, entry.options.config) } catch { throw new Error('Cannot resolve potential Hub source; admission blocked') }
      if (source?.transport === 'stdio' && this.owned.has(source.serverName)) selected.add(entry)
    }
    for (const entry of selected) {
      if (!entry.disabled || entry.options.disabled !== true) {
        if (typeof entry.update !== 'function') throw new Error('NEEDS_CONTEXT: Loader cannot retire the active Hub source')
        await entry.update({ disabled: true })
      }
      await entry.fiber?.await?.()
      if (entry.fiber?.uid) throw new Error('Hub source disposal not confirmed')
    }
  }
  async retireHub(names) {
    if (!names?.size) return
    for (const lease of this.allLeases()) if (names.has(lease.server)) this.revoke(lease)
    const physical = this.physical
    if (physical?.calls) {
      const deadline = Date.now() + 10000
      while (physical.calls) {
        if (Date.now() >= deadline) throw new Error('Hub release is waiting for in-flight calls')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
  async beforeRequest(signal) {
    aborted(signal)
    if (this.closed || this.localError || this.error) throw new Error(this.error ?? 'Hub admission blocked')
    await this.retireOfficial()
    await this.ownership.barrier(signal)
    aborted(signal)
    if (this.closed) throw new Error('Hub manager disposed')
  }
  acquirePhysical() {
    if (!this.physical || this.physical.closed) {
      const generation = this.generation
      const physical = { generation, refs: new Set(), calls: 0, closed: false, discovery: null }
      physical.connection = new HttpConnection(this.endpointValue.server, signal => this.beforeRequest(signal), () => {
        // Notifications retire the trusted execution snapshot without waking an
        // idle client. Only explicit refresh/load obtains a new list.
        if (this.physical !== physical) return
        for (const lease of this.allLeases()) this.revoke(lease)
        this.snapshots.clear()
      })
      this.physical = physical
    }
    const ref = { physical: this.physical, released: false }
    ref.physical.refs.add(ref)
    return ref
  }
  release(ref) {
    if (ref.released) return
    ref.released = true
    ref.physical.refs.delete(ref)
    this.maybeClose(ref.physical)
  }
  maybeClose(physical) {
    if (physical.refs.size || physical.calls || physical.closed) return
    physical.closed = true
    if (this.physical === physical) this.physical = null
    const closing = physical.connection.dispose()
    this.closing ??= new Set()
    this.closing.add(closing)
    closing.finally(() => this.closing.delete(closing)).catch(() => {})
  }
  async closePhysical() {
    const physical = this.physical
    if (physical) {
      for (const ref of [...physical.refs]) this.release(ref)
      if (physical.calls) {
        await new Promise(resolve => { physical.drained = resolve })
      }
      this.maybeClose(physical)
    }
    await Promise.all([...(this.closing ?? [])])
  }
  async discover(ref, signal, force = false) {
    const physical = ref.physical
    if (ref.released || physical.closed) throw new Error('Hub reference released')
    // A tool snapshot belongs to one logical service. An existing snapshot for
    // another service must never short-circuit discovery for this one.
    if (!force && this.services.size && [...this.services.keys()].every(name => this.snapshots.has(name))) return
    if (!physical.discovery) {
      const task = (async () => {
        await this.beforeRequest()
        const tools = await physical.connection.listTools()
        if (this.closed || physical.closed || this.physical !== physical || physical.generation !== this.generation) throw new Error('Hub discovery generation retired')
        const grouped = new Map(), seen = new Set(), issues = new Map(), owners = new Map()
        const block = (name, why) => { if (!issues.has(name)) issues.set(name, why) }
        for (const tool of tools) {
          if (!tool || typeof tool.name !== 'string') throw new Error('Invalid Hub raw tool name')
          // A repeated wire name is a fault of that one entry: skip it and keep
          // the rest of the listing usable.
          if (seen.has(tool.name)) { block(null, `duplicate raw tool name ${tool.name}`); continue }
          seen.add(tool.name)
          // Match the original upstream name against known source identities;
          // never derive a wire name from its normalized public tool name.
          const matches = [...this.services.values()].filter(service => tool.name.startsWith(prefixOf(service.name)))
          if (!matches.length) continue
          if (matches.length !== 1) {
            // Ambiguity is a property of these candidates, not of the whole
            // Hub: block only them so every other service keeps working.
            for (const candidate of matches) block(candidate.name, `raw tool ${tool.name} matches more than one Library source`)
            continue
          }
          const service = matches[0]
          const rawLocal = tool.name.slice(prefixOf(service.name).length)
          if (service.disabledTools.some(disabled => disabled === rawLocal || disabled === tool.name || (prefixOf(service.name) + disabled.replace(/[^A-Za-z0-9_-]/g, '-')).slice(0, 64) === tool.name)) continue
          const publicName = hubPublicName(service.name, rawLocal)
          // Two services whose names normalize to the same model-facing
          // namespace would shadow each other, so both are blocked instead.
          const owner = owners.get(publicName)
          if (owner && owner !== service.name) {
            block(service.name, `public tool name ${publicName} collides with service ${owner}`)
            block(owner, `public tool name ${publicName} collides with service ${service.name}`)
            continue
          }
          owners.set(publicName, service.name)
          const group = grouped.get(service.name) ?? []
          group.push({ ...tool, publicName, rawName: tool.name })
          grouped.set(service.name, group)
        }
        // A blocked service loses its authorization rather than failing the
        // whole listing: no snapshot, no lease, and a named reason to report.
        for (const name of issues.keys()) {
          if (!name) continue
          grouped.delete(name)
          if (this.snapshots.delete(name)) for (const lease of this.allLeases()) if (lease.server === name) this.revoke(lease)
        }
        this.mappingIssues = new Map([...issues].filter(([name]) => name))
        this.listIssues = [...issues].filter(([name]) => !name).map(([, why]) => why)
        for (const [name, group] of grouped) {
          const publicNames = new Set()
          for (const tool of group) {
            if (publicNames.has(tool.publicName)) throw new Error('Hub public tool identity collision')
            publicNames.add(tool.publicName)
          }
          const previous = this.snapshots.get(name)
          if (previous && !same(previous.tools, group)) {
            for (const lease of this.allLeases()) if (lease.server === name && lease.ready) this.revoke(lease)
          }
          this.snapshots.set(name, { tools: group, generation: this.generation, identity: hash(group) })
          await this.hooks.remember?.(name, group, physical.connection.serverInfo)
        }
        // A successful Hub list can silently omit unavailable backends. Absence
        // is not deletion; only trusted local assignment changes revoke sources.
      })()
      physical.discovery = task
      task.finally(() => { if (physical.discovery === task) physical.discovery = null }).catch(() => {})
    }
    await this.hooks.waitFor(physical.discovery, signal)
    if (ref.released || physical.closed) throw new Error('Hub discovery reference released')
  }
  valid(lease) {
    return !this.closed && !lease.closed && lease.ready && lease.generation === this.generation && !lease.ref.released && !lease.ref.physical.closed && this.services.has(lease.server) && this.snapshots.get(lease.server)?.identity === lease.identity && this.hooks.live(lease.agent)
  }
  async bridge() {
    if (!this.bridgePromise) this.bridgePromise = (async () => {
      let module
      try {
        const direct = await import('@deepseek-ai/dsh-mcp-client')
        if (typeof direct?.createMcpToolDefinition === 'function') module = direct
      } catch {}
      if (!module) {
        module = await this.loader()?.import?.('@deepseek-ai/dsh-mcp-client')
      }
      if (typeof module?.createMcpToolDefinition !== 'function') throw new Error('NEEDS_CONTEXT: Host public createMcpToolDefinition unavailable')
      return module.createMcpToolDefinition
    })()
    return this.bridgePromise
  }
  async load(agent, server, signal) {
    await this.reload()
    aborted(signal)
    if (this.error || !this.services.has(server)) throw new Error(this.error ?? 'Hub logical service is no longer assigned')
    let map = this.leases.get(agent)
    let lease = map?.get(server)
    if (lease && !lease.closed) return this.join(lease, signal)
    if (!map) this.leases.set(agent, map = new Map())
    lease = { agent, server, ref: this.acquirePhysical(), registrations: new Map(), closed: false, ready: false, active: 0, turnsSinceLastCall: 0, usedInTurn: false, lastCompletedTurn: 0, waiters: new Set(), generation: this.generation }
    map.set(server, lease)
    lease.loading = (async () => {
      await this.discover(lease.ref, undefined, true)
      const snapshot = this.snapshots.get(server)
      if (!snapshot) throw new Error(`Hub service omitted from discovery${this.mappingIssues?.get(server) ? `: ${this.mappingIssues.get(server)}` : '; last trusted ownership retained'}`)
      if (lease.closed || this.closed || lease.generation !== this.generation || !this.hooks.live(agent)) throw new Error('Hub load generation retired')
      lease.identity = snapshot.identity
      const create = await this.bridge()
      for (const tool of snapshot.tools) {
        const definition = create(agent.ctx, {
          name: tool.publicName, rawName: tool.rawName, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }, outputSchema: tool.outputSchema,
          taskRequired: tool.execution?.taskSupport === 'required',
          call: (args, exec) => this.execute(lease, tool, args, exec),
        })
        const execute = definition.execute
        definition.execute = async (args, exec) => {
          await this.reload()
          if (exec?.agent !== agent || !this.valid(lease)) throw new Error('Hub tool lease revoked before execution; call mcp_load again')
          return execute(args, exec) // Preserve the exact exec for image projection.
        }
        this.gate.authorize(agent, definition, () => this.valid(lease))
        lease.registrations.set(tool.publicName, agent.ctx.tools.register(definition))
      }
      if (lease.closed || lease.generation !== this.generation || !this.hooks.live(agent)) throw new Error('Hub load cancelled before commit')
      lease.ready = true
      return lease
    })().catch(error => { this.revoke(lease); throw error }).finally(() => { lease.loading = null })
    return this.join(lease, signal)
  }
  async join(lease, signal) {
    const waiter = Symbol()
    lease.waiters.add(waiter)
    try {
      await this.hooks.waitFor(lease.loading ?? Promise.resolve(), signal)
      aborted(signal)
      if (!this.valid(lease)) throw new Error('Hub load lease retired')
      return lease
    } finally {
      lease.waiters.delete(waiter)
      if (signal?.aborted && lease.loading && !lease.waiters.size) this.revoke(lease)
    }
  }
  async execute(lease, tool, args, exec) {
    // This is after policy/approval and immediately before submission. The
    // same lease/source checks are repeated even for retained old definitions.
    await this.reload()
    if (exec?.agent !== lease.agent || !this.valid(lease)) throw new Error('Hub tool lease revoked before submission')
    aborted(exec.signal)
    const physical = lease.ref.physical
    // Admission runs before the in-flight counters. Ownership reconciliation
    // waits for in-flight calls to drain while this call waits for
    // reconciliation, so counting it first would deadlock the pair until the
    // retire deadline expires.
    await this.beforeRequest(exec.signal)
    if (!this.valid(lease)) throw new Error('Hub tool lease revoked before submission')
    lease.active++; physical.calls++
    lease.turnsSinceLastCall = 0; lease.usedInTurn = true
    try {
      // Re-check after counting: a revocation that raced the admission check
      // must not submit a call on a retired lease.
      if (!this.valid(lease)) throw new Error('Hub tool lease revoked before submission')
      return await physical.connection.call(tool.rawName, args, exec.signal, tool)
    } finally {
      lease.active--; physical.calls--
      if (!physical.calls) physical.drained?.()
      if (lease.expired && !lease.active) this.revoke(lease)
      this.maybeClose(physical)
    }
  }
  async refresh(server, agent, signal) {
    await this.reload()
    if (this.error) throw new Error(this.error)
    const ref = this.acquirePhysical()
    try {
      await this.discover(ref, signal, true)
      const blocked = this.mappingIssues?.get(server)
      if (blocked) throw new Error(`Hub mapping blocked: ${blocked}`)
      return this.snapshots.get(server)?.tools.length ?? 0
    } finally { this.release(ref) }
  }
  revoke(lease) {
    if (lease.closed) return
    lease.closed = true
    for (const dispose of lease.registrations.values()) dispose()
    lease.registrations.clear()
    this.release(lease.ref)
    const map = this.leases.get(lease.agent)
    if (map?.get(lease.server) === lease) map.delete(lease.server)
    if (!map?.size) this.leases.delete(lease.agent)
  }
  unload(agent, server) {
    const lease = this.leases.get(agent)?.get(server)
    if (!lease) return false
    this.revoke(lease)
    return true
  }
  close(agent) { for (const lease of this.leases.get(agent)?.values() ?? []) this.revoke(lease) }
  loaded(agent, server) { return this.leases.get(agent)?.get(server) }
  turn(session, event, threshold) {
    for (const lease of this.allLeases()) {
      if (lease.agent.session !== session || event.data.turn <= lease.lastCompletedTurn) continue
      lease.lastCompletedTurn = event.data.turn
      lease.turnsSinceLastCall = lease.usedInTurn ? 0 : lease.turnsSinceLastCall + 1
      lease.usedInTurn = false
      if (lease.turnsSinceLastCall >= threshold) {
        if (lease.active || lease.loading || lease.agent.status === 'running') lease.expired = true
        else this.revoke(lease)
      }
    }
  }
  idle(agent) { for (const lease of this.leases.get(agent)?.values() ?? []) if (lease.expired && !lease.active && !lease.loading) this.revoke(lease) }
  dispose() {
    if (this.stopping) return this.stopping
    this.closed = true
    this.watcher?.close()
    for (const lease of this.allLeases()) this.revoke(lease)
    this.stopping = (async () => {
      await this.reloadQueue.catch(() => {})
      await this.closePhysical()
      await this.hooks.retireDirect(new Set(this.owned))
      await this.ownership.dispose()
    })()
    return this.stopping
  }
}
