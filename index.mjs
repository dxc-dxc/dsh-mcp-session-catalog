import { spawn } from 'node:child_process'
import { ConnectionPool } from './pool.mjs?generation=2.5.0'
import { HubAdapter } from './hub-adapter.mjs'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'mcp-session-catalog'
export const inject = ['tools', 'agents', 'systemPrompt']
const VERSION = '2.5.0'
const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
const transient = error => /fetch failed|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|connection closed|server.*exited|temporarily unavailable|\b50[234]\b/i.test(error?.message ?? '')
const waitFor = (promise, signal) => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('MCP call aborted'))
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('MCP call aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('MCP call aborted'))
  const done = () => { signal?.removeEventListener('abort', cancel); resolve() }
  const timer = setTimeout(done, ms)
  const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('MCP call aborted')) }
  signal?.addEventListener('abort', cancel, { once: true })
})

const stoppingChildren = new WeakSet()
const expandHomePath = path => {
  if (typeof path !== 'string') return path
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}
// Loader entries are the effective, layered DSH configuration. A disabled
// official client provides a definition without starting a second connection.
const getLoader = ctx => {
  try {
    return ctx?.get ? ctx.get('loader') : ctx?.loader
  } catch {
    return null
  }
}
const mcpEntryServer = entry => {
  try {
    if (entry?.options?.name !== '@deepseek-ai/dsh-mcp-client' || entry.options.disabled !== true || !entry.disabled) return null
    for (let parent = entry.parent?.ctx?.fiber?.entry; parent; parent = parent.parent?.ctx?.fiber?.entry) {
      const disabled = parent.options?.disabled
      if (parent.disabled || disabled === true || (disabled?.__jsExpr && parent.evaluate(disabled.__jsExpr))) return null
    }
    const config = entry.options.config
    if (!config || config.transport !== 'stdio') return null
    const interpolate = value => {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string') return entry.evaluate(value.__jsExpr)
      if (Array.isArray(value)) return value.map(interpolate)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item)]))
      return value
    }
    const source = interpolate(config)
    return {
      serverName: source.serverName,
      purpose: source.purpose ?? source.description ?? `${source.serverName} (DSH profile)`,
      command: source.command, args: source.args ?? [], env: source.env ?? {}, cwd: source.cwd,
      sharing: source.sharing ?? 'shared', inactiveTurnsThreshold: source.inactiveTurnsThreshold,
      toolCallTimeoutMs: source.toolCallTimeoutMs, connectTimeoutMs: source.connectTimeoutMs,
    }
  } catch {
    return null
  }
}
const dshDefinitions = ctx => {
  const loader = getLoader(ctx)
  if (!loader?.entries) return []
  const entries = [...loader.entries()]
  const active = new Set(entries.filter(entry => entry.options?.name === '@deepseek-ai/dsh-mcp-client' && !entry.disabled).map(entry => {
    const value = entry.options.config?.serverName
    return value?.__jsExpr ? entry.evaluate(value.__jsExpr) : value
  }))
  return entries.map(mcpEntryServer).filter(server => server && !active.has(server.serverName))
}

function terminateTree(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1) return Promise.resolve()
  if (stoppingChildren.has(child)) return child.mcpStopped
  let resolveStopped, rejectStopped
  child.mcpStopped = new Promise((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject })
  child.mcpStopped.catch(() => {})
  stoppingChildren.add(child)
  const signal = value => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, value)
      else child.kill(value)
    } catch {}
  }
  signal('SIGTERM')
  // The wrapper may already have exited while a grandchild still owns the group.
  const timer = setTimeout(() => signal('SIGKILL'), 2000)
  timer.unref?.()
  const deadline = Date.now() + 5000
  let lastError = null
  const observe = () => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0) }
    catch (error) {
      if (error.code === 'ESRCH') { clearTimeout(timer); resolveStopped(); return }
      // EPERM and similar mean the probe could not answer, not that the group
      // is gone: keep polling to the deadline instead of failing on the first
      // inconclusive answer.
      lastError = error
    }
    if (Date.now() >= deadline) {
      clearTimeout(timer)
      rejectStopped(new Error(`MCP process exit cannot be confirmed${lastError ? ` (${lastError.code ?? lastError.message})` : ''}`))
      return
    }
    setTimeout(observe, 20)
  }
  observe()
  return child.mcpStopped
}

// A Connection belongs to a pool, not to an Agent. Agent leases independently
// control tool visibility; shared pools also share backend application state.
// Callbacks from an old child process cannot affect its replacement.
export class Connection {
  constructor(server, ownership) {
    this.server = server
    this.ownership = ownership
    this.directToken = randomUUID()
    this.stopping = new Set()
    this.child = null
    this.ready = null
    this.pending = new Map()
    this.sequence = 0
    this.buffer = ''
    this.closed = false
    this.serverInfo = null
  }
  ensure() {
    if (this.closed) return Promise.reject(new Error('MCP connection disposed'))
    if (!this.ready) {
      const ready = Promise.resolve().then(() => this.start())
      this.ready = ready
      ready.catch(() => { if (this.ready === ready) this.stop('MCP connection failed') })
    }
    return this.ready
  }
  async start() {
    if (this.closed) throw new Error('MCP connection disposed')
    if (this.ownership) {
      await this.ownership.enterDirect(this.server.serverName, this.directToken)
      if (this.closed) { await this.ownership.exitDirect(this.directToken); throw new Error('MCP connection disposed') }
      this.ownership.assertDirect(this.server.serverName)
    }
    const child = spawn(this.server.command, this.server.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, ...this.server.env },
      ...(this.server.cwd ? { cwd: expandHomePath(this.server.cwd) } : {}),
    })
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (this.child !== child) return
      this.buffer += chunk
      if (this.buffer.length > 16 * 1024 * 1024) return this.stop('MCP response exceeded transport limit')
      for (;;) {
        const end = this.buffer.indexOf('\n')
        if (end < 0) break
        const line = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue
        if (message.id !== undefined && message.method) {
          const result = message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client request not supported' } }
          try { this.send({ jsonrpc: '2.0', id: message.id, ...result }) }
          catch { this.stop('MCP connection closed while answering server request'); return }
          continue
        }
        const entry = this.pending.get(message.id)
        if (!entry) continue
        this.pending.delete(message.id)
        entry.finish()
        if (message.error) entry.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`))
        else entry.resolve(message.result)
      }
    })
    // Drain stderr but never log credential-bearing child output verbatim.
    child.stderr.resume()
    child.stdin.on('error', error => { if (this.child === child) this.fail(error) })
    child.on('error', error => { if (this.child === child) this.fail(error) })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.fail(new Error(`MCP server ${this.server.serverName} exited (${code ?? signal})`))
    })
    const init = await this.request('initialize', {
      protocolVersion: this.server.protocolVersion ?? '2025-06-18',
      capabilities: {}, clientInfo: { name, version: VERSION },
    }, undefined, this.server.connectTimeoutMs ?? 30000)
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.serverInfo = init?.serverInfo ?? null
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('MCP connection closed')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  request(method, params, signal, timeout = this.server.toolCallTimeoutMs ?? 120000) {
    if (signal?.aborted) return Promise.reject(new Error('MCP call aborted'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const abort = () => {
        this.pending.delete(id); finish()
        try { this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Caller aborted' } }) } catch {}
        reject(new Error('MCP call aborted'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id); finish(); reject(new Error(`MCP ${method} timed out after ${timeout}ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, finish })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { this.pending.delete(id); finish(); reject(error) }
    })
  }
  async listTools(signal) {
    await waitFor(this.ensure(), signal)
    const tools = [], seen = new Set()
    let cursor
    for (let page = 0; page < 100; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal)
      tools.push(...(result?.tools ?? []))
      cursor = result?.nextCursor
      if (!cursor) return tools
      if (seen.has(cursor)) throw new Error('MCP tool pagination repeated a cursor')
      seen.add(cursor)
    }
    throw new Error('MCP tool pagination exceeded 100 pages')
  }
  async call(tool, args, signal) {
    await waitFor(this.ensure(), signal)
    const result = await this.request('tools/call', { name: tool, arguments: args ?? {} }, signal)
    if (result?.isError) throw new Error(renderResult(result, 4000) || `MCP ${tool} failed`)
    return result
  }
  fail(error) {
    const child = this.child
    this.child = null; this.ready = null
    for (const pending of this.pending.values()) { pending.finish(); pending.reject(error) }
    this.pending.clear()
    const closing = Promise.resolve(terminateTree(child)).then(() => this.ownership?.exitDirect(this.directToken))
    this.stopping.add(closing)
    closing.finally(() => this.stopping.delete(closing)).catch(() => {})
    return closing
  }
  stop(reason = 'MCP connection closed') {
    const child = this.child
    const stopping = this.fail(new Error(reason))
    if (child) { try { child.stdin.end() } catch {} }
    return stopping
  }
  async dispose() { this.closed = true; await this.stop('MCP connection disposed'); await Promise.all([...this.stopping]) }
}
function renderResult(result, max) {
  const parts = (result?.content ?? []).map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'resource' && typeof block.resource?.text === 'string') return block.resource.text
    if (block.type === 'resource_link') return `[resource: ${block.uri ?? ''}] ${block.description ?? ''}`
    return `[${block.type} content omitted]`
  })
  if (result?.structuredContent) parts.push(JSON.stringify(result.structuredContent))
  const text = parts.join('\n').trim()
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text
}
function safeRead(server, tool) {
  if (tool.annotations?.readOnlyHint === true) return true
  return Array.isArray(server.readOnlyTools) && server.readOnlyTools.includes(tool.name)
}
function normalizeServers(servers) {
  if (!Array.isArray(servers)) throw new Error('MCP servers must be an array')
  const seen = new Set()
  return servers.map(server => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName ?? '') || seen.has(server.serverName)) throw new Error('Invalid or duplicate MCP serverName')
    seen.add(server.serverName)
    if (typeof server.command !== 'string' || !server.command || (server.args && (!Array.isArray(server.args) || server.args.some(x => typeof x !== 'string')))) throw new Error(`Invalid MCP command for ${server.serverName}`)
    if (server.transport !== undefined && server.transport !== 'stdio') throw new Error('Only stdio MCP transport is supported')
    if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env) || Object.values(server.env).some(value => typeof value !== 'string'))) throw new Error('MCP env values must be strings')
    if (server.cwd !== undefined && typeof server.cwd !== 'string') throw new Error('MCP cwd must be a string')
    for (const key of ['connectTimeoutMs', 'toolCallTimeoutMs']) if (server[key] !== undefined && (!Number.isSafeInteger(server[key]) || server[key] < 1 || server[key] > 2147483647)) throw new Error(`Invalid MCP ${key}`)
    if (server.sharing !== undefined && !['shared', 'session'].includes(server.sharing)) throw new Error(`Invalid MCP sharing mode for ${server.serverName}`)
    if (server.inactiveTurnsThreshold !== undefined && (!Number.isSafeInteger(server.inactiveTurnsThreshold) || server.inactiveTurnsThreshold < 1)) throw new Error(`Invalid MCP inactiveTurnsThreshold for ${server.serverName}`)
    if (Object.hasOwn(server, 'idleTimeoutMs') || Object.hasOwn(server, 'serviceIdleTimeoutMs')) throw new Error('Wall-clock MCP expiry was retired; configure inactiveTurnsThreshold')
    return server
  })
}
export function apply(ctx, config = {}) {
  if (Object.hasOwn(config, 'idleTimeoutMs') || Object.hasOwn(config, 'serviceIdleTimeoutMs')) throw new Error('Wall-clock MCP expiry was retired; configure inactiveTurnsThreshold')
  if (config.profilePatchFile !== undefined) throw new Error('profilePatchFile was replaced by native DSH Loader discovery; remove this option')
  const loader = getLoader(ctx)
  const manual = config.servers !== undefined || config.serversFile !== undefined
  const scanDsh = config.scanDshProfile ?? (!manual && Boolean(loader?.entries))
  if (config.scanDshProfile && !loader?.entries) throw new Error('DSH Loader is required for native MCP discovery')
  const serversFile = config.servers === undefined && config.serversFile ? expandHomePath(config.serversFile) : undefined
  const sourceDefinitions = parsed => Array.isArray(parsed) ? parsed : parsed?.servers
  const rawJsonTop = serversFile ? JSON.parse(readFileSync(serversFile, 'utf8')) : null
  const excluded = new Set(config.excludedServers ?? [])
  const discovered = () => scanDsh ? dshDefinitions(ctx).filter(server => !excluded.has(server.serverName)) : []
  const nativeStatus = () => (!scanDsh || !loader?.entries) ? '' : [...loader.entries()]
    .filter(entry => entry.options?.name === '@deepseek-ai/dsh-mcp-client')
    .map(entry => {
      const id = entry.options.config?.serverName
      const label = typeof id === 'string' ? id : entry.options.id
      const status = !entry.disabled ? 'official client enabled; not managed here' :
        excluded.has(id) ? 'excluded from on-demand loading' :
        servers.some(server => server.serverName === id) ? 'on-demand managed' : 'unsupported transport or disabled parent/conditional entry'
      return `${label}: ${status}`
    }).join('\n')
  let hub = null
  const definitions = () => [
    ...(config.servers ?? (rawJsonTop ? sourceDefinitions(rawJsonTop) : [])),
    ...discovered(),
  ]
  let servers = normalizeServers(definitions())
  let reloadError = null
  let hubFailure = null
  let reloadQueue = Promise.resolve()
  const managementDisposers = []
  const pools = new ConnectionPool(server => new Connection(server, hub?.ownership), waitFor, transient, delay)
  const states = new Map()
  const sessionStates = new WeakMap()
  const scans = new Map()
  const closedAgents = new WeakSet()
  let archivedSessions = new Set()
  let disposed = false
  let inactiveTurns = rawJsonTop?.inactiveTurnsThreshold ?? config.inactiveTurnsThreshold ?? 20
  if (!Number.isSafeInteger(inactiveTurns) || inactiveTurns < 1) throw new Error('inactiveTurnsThreshold must be a positive integer')
  const cacheFile = expandHomePath(config.cacheFile ?? join(homedir(), '.dsh/cache/mcp-session-catalog.json'))
  let catalog = { version: 2, servers: Object.create(null) }, writing = Promise.resolve()
  const cacheReady = readFile(cacheFile, 'utf8').then(raw => {
    const parsed = JSON.parse(raw)
    if (parsed.version === 2 && parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)) {
      catalog = { version: 2, servers: Object.assign(Object.create(null), parsed.servers) }
      const activeNames = new Set(servers.map(s => s.serverName))
      let pruned = false
      for (const name of Object.keys(catalog.servers)) {
        if (!activeNames.has(name)) {
          delete catalog.servers[name]
          pruned = true
        }
      }
      if (pruned) persist()
    }
  }).catch(() => {})
  const persist = () => {
    const text = JSON.stringify(catalog)
    writing = writing.catch(() => {}).then(async () => {
      await mkdir(dirname(cacheFile), { recursive: true })
      const temp = `${cacheFile}.${process.pid}.tmp`
      await writeFile(temp, text); await rename(temp, cacheFile)
    }).catch(() => ctx.logger?.warn?.('MCP catalog cache could not be saved'))
    return writing
  }
  const serverOf = id => {
    const server = servers.find(item => item.serverName === id)
    if (!server) throw new Error(`Unknown MCP server ${id}; known: ${servers.map(x => x.serverName).join(', ')}`)
    return server
  }
  const isArchived = agent => archivedSessions.has(agent?.session?.id ?? agent?.id)
  const caller = exec => {
    const agent = exec?.agent
    if (disposed || isArchived(agent) || closedAgents.has(agent) || !agent?.ctx?.tools || (ctx.agents?.get && ctx.agents.get(agent.id) !== agent)) throw new Error('MCP loading requires a live, unarchived calling session')
    return agent
  }
  const stateOf = agent => {
    let state = states.get(agent)
    if (!state) {
      state = { agent, closed: false, leases: new Map() }
      states.set(agent, state)
      if (agent.session) sessionStates.set(agent.session, state)
    }
    return state
  }
  const remember = async (server, tools, info) => {
    await cacheReady
    if (disposed || !servers.some(current => current.serverName === server.serverName && JSON.stringify(current) === JSON.stringify(server))) return
    catalog.servers[server.serverName] = { updatedAt: Date.now(), serverInfo: info ? { name: info.name, version: info.version } : null, tools: tools.map(({ name, description }) => ({ name, description: description?.slice(0, 160) ?? '' })) }
    await persist()
  }
  const revoke = (state, lease) => {
    if (lease.closed) return
    lease.closed = true
    for (const unregister of lease.registrations.values()) unregister()
    lease.registrations.clear()
    pools.release(lease.ref)
    if (state.leases.get(lease.server.serverName) === lease) state.leases.delete(lease.server.serverName)
    if (!state.leases.size) {
      states.delete(state.agent)
      if (state.agent.session) sessionStates.delete(state.agent.session)
    }
  }
  const expire = (state, lease) => {
    if (lease.closed) return
    const isStale = lease.stale || lease.ref?.pool?.stale
    if (lease.active || lease.loading || (!isStale && state.agent.status === 'running')) {
      lease.expired = true
      return
    }
    revoke(state, lease)
  }
  const alive = (state, lease) => !disposed && !isArchived(state.agent) && !state.closed && !lease.closed && states.get(state.agent) === state && (!ctx.agents?.get || ctx.agents.get(state.agent.id) === state.agent)
  const executeNative = async (state, lease, tool, args, exec) => {
    await reloadDefinitions()
    hub?.assertDirect(lease.server.serverName)
    if (exec?.agent !== state.agent || !alive(state, lease)) throw new Error('MCP tool not loaded in this session; call mcp_load again')
    if (lease.stale || lease.ref?.pool?.stale) throw new Error('MCP service configuration retired; call mcp_load again')
    lease.active++
    lease.turnsSinceLastCall = 0
    lease.usedInTurn = true
    if (!lease.stale && !lease.ref?.pool?.stale) {
      lease.expired = false
    }
    const attempts = safeRead(lease.server, tool) ? 3 : 1
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        hub?.assertDirect(lease.server.serverName)
        if (lease.stale || lease.ref?.pool?.stale) throw new Error('MCP service configuration retired; call mcp_load again')
        try {
          const result = await pools.call(lease.ref, tool.name, args, exec.signal)
          return renderResult(result, config.maxResultChars ?? 60000) || '(MCP tool returned no text)'
        } catch (error) {
          if (exec.signal?.aborted || lease.stale || lease.ref?.pool?.stale || !alive(state, lease) || attempt === attempts - 1 || !transient(error)) throw error
          await delay(500 * (2 ** attempt), exec.signal)
        }
      }
    } finally {
      lease.active--
      const shouldExpire = lease.expired || lease.stale || lease.ref?.pool?.stale
      if (alive(state, lease) && shouldExpire) expire(state, lease)
    }
  }
  const joinLoad = async (state, lease, signal) => {
    if (signal?.aborted) throw new Error('MCP call aborted')
    const waiter = Symbol()
    lease.waiters.add(waiter)
    try {
      if (lease.loading) await waitFor(lease.loading, signal)
      if (signal?.aborted || !alive(state, lease)) throw new Error('MCP load cancelled by session disposal')
      return lease
    } finally {
      lease.waiters.delete(waiter)
      if (signal?.aborted && lease.loading && !lease.waiters.size) revoke(state, lease)
    }
  }
  const load = async (agent, server, signal) => {
    if (signal?.aborted || disposed || isArchived(agent) || closedAgents.has(agent)) throw new Error('MCP load cancelled')
    hub?.assertDirect(server.serverName)
    let state = stateOf(agent)
    let lease = state.leases.get(server.serverName)
    if (lease && !lease.closed) {
      if (lease.stale || lease.ref?.pool?.stale) {
        revoke(state, lease)
        state = stateOf(agent)
      } else {
        return joinLoad(state, lease, signal)
      }
    }
    lease = { server, ref: pools.acquire(server, agent), registrations: new Map(), closed: false, active: 0, loading: null, waiters: new Set(), turnsSinceLastCall: 0, usedInTurn: false, lastCompletedTurn: 0, expired: false, stale: false }
    state.leases.set(server.serverName, lease)
    lease.loading = (async () => {
      const tools = await pools.tools(lease.ref)
      if (!alive(state, lease) || lease.stale || lease.ref?.pool?.stale) throw new Error('MCP load cancelled before registration')
      await remember(server, tools, lease.ref.pool.connection.serverInfo)
      if (!alive(state, lease) || lease.stale || lease.ref?.pool?.stale) throw new Error('MCP load cancelled before registration')
      for (const tool of tools) {
        const publicName = `mcp__${server.serverName}__${tool.name.replace(/[^A-Za-z0-9_-]/g, '_')}`
        if (publicName.length > 64 || lease.registrations.has(publicName)) throw new Error(`MCP tool name invalid or collides: ${publicName}`)
        const unregister = agent.ctx.tools.register({
          name: publicName, description: (tool.description ?? `${server.serverName}: ${tool.name}`).slice(0, 2048),
          parameters: tool.inputSchema ?? { type: 'object', properties: {} }, output: textOutput,
          execute: (args, exec) => executeNative(state, lease, tool, args, exec),
        })
        lease.registrations.set(publicName, unregister)
      }
      return lease
    })().catch(error => { revoke(state, lease); throw error }).finally(() => { lease.loading = null })
    return joinLoad(state, lease, signal)
  }
  const close = agent => {
    hub?.close(agent)
    closedAgents.add(agent)
    for (const [ref, owner] of scans) if (owner === agent) { pools.release(ref); scans.delete(ref) }
    const state = states.get(agent)
    if (!state) return
    state.closed = true
    for (const lease of [...state.leases.values()]) revoke(state, lease)
    states.delete(agent)
  }
  const scan = async (server, signal, agent) => {
    if (disposed || isArchived(agent) || signal?.aborted || closedAgents.has(agent)) throw new Error('MCP refresh cancelled')
    hub?.assertDirect(server.serverName)
    const ref = pools.acquire(server, agent, 'scan')
    scans.set(ref, agent)
    try {
      const tools = await pools.tools(ref, true, signal)
      if (disposed || isArchived(agent) || signal?.aborted || closedAgents.has(agent)) throw new Error('MCP refresh cancelled')
      await remember(server, tools, ref.pool.connection.serverInfo)
      return tools.length
    } finally { pools.release(ref); scans.delete(ref) }
  }
  const summarize = list => list.map(x => `${x.serverName} (${x.purpose ?? ''})`).join('; ')
  // Serialize snapshots and commits; an older reload can never overwrite a newer one.
  const reloadDefinitions = () => {
    const next = reloadQueue.then(reloadOnce)
    reloadQueue = next.catch(() => {})
    return next
  }
  const reloadOnce = async () => {
    if ((!serversFile && !scanDsh && !hub) || disposed) return
    if (hub) {
      // A Hub-side failure (ownership registry, lock, retirement) degrades the
      // Hub path only. It must never take away management of independent stdio
      // services, whose contracts are unchanged by v2.5.
      try { await hub.reload(); hubFailure = null }
      catch (error) { hubFailure = `Magpie Hub unavailable: ${error.message}` }
    }
    let next, nextInactive = config.inactiveTurnsThreshold ?? 20
    try {
      const parsed = serversFile ? JSON.parse(await readFile(serversFile, 'utf8')) : null
      if (parsed && !Array.isArray(parsed) && parsed.inactiveTurnsThreshold !== undefined) nextInactive = parsed.inactiveTurnsThreshold
      if (!Number.isSafeInteger(nextInactive) || nextInactive < 1) throw new Error('inactiveTurnsThreshold must be a positive integer')
      next = normalizeServers([
        ...(config.servers ?? (parsed ? sourceDefinitions(parsed) : [])),
        ...discovered(),
      ].filter(server => !hub?.owns(server.serverName)))
      if (hub) next.push(...hub.definitions())
    } catch {
      // Diagnostics deliberately omit configuration values and expression errors.
      reloadError = 'connection file rejected; previous configuration kept (check source and server fields)'
      return
    }
    if (disposed) return
    await cacheReady
    if (disposed) return
    inactiveTurns = nextInactive
    reloadError = null
    const before = new Map(servers.map(server => [server.serverName, server]))
    const after = new Map(next.map(server => [server.serverName, server]))
    const retired = [...before].filter(([name, previous]) => {
      const updated = after.get(name)
      return !updated || JSON.stringify(previous) !== JSON.stringify(updated)
    }).map(([name]) => name)
    const summaryChanged = summarize(servers) !== summarize(next)
    servers = next
    for (const name of retired) {
      pools.markStale(name)
      for (const state of [...states.values()]) {
        const lease = state.leases.get(name)
        if (lease) {
          lease.stale = true
          expire(state, lease)
        }
      }
      if (!after.has(name)) delete catalog.servers[name]
    }
    if (retired.length) await persist()
    if (summaryChanged) registerManagement()
  }
  function registerManagement() {
    while (managementDisposers.length) managementDisposers.pop()()
    managementDisposers.push(ctx.tools.register({
      name: 'mcp_catalog',
      description: `Discover on-demand MCP servers and their tool names: ${summarize(servers)}. Shows only this session's loaded state; reading the catalog does not start servers.`,
      parameters: { type: 'object', properties: {}, additionalProperties: false }, output: textOutput,
      async execute(_args, exec) {
        await reloadDefinitions()
        await cacheReady
        const loaded = states.get(exec?.agent)?.leases
        const body = servers.map(server => {
          const entry = catalog.servers[server.serverName], lease = server.hub ? hub.loaded(exec?.agent, server.serverName) : loaded?.get(server.serverName)
          const names = entry?.tools?.map(tool => `  ${tool.name} — ${tool.description.slice(0, 100)}`).join('\n') ?? '  Tool list not cached; call mcp_load to discover and load.'
          return `${server.serverName} — ${server.purpose ?? ''} [${lease ? 'loaded in this session' : 'not loaded'}]\n${names}`
        }).join('\n\n')
        const inventory = nativeStatus()
        const mapping = hub?.mappingIssues?.size ? `Hub services blocked by tool mapping: ${[...hub.mappingIssues].map(([name, why]) => `${name} (${why})`).join('; ')}` : null
        const hubNotice = hubFailure ?? hub?.error ?? mapping ?? (hub?.hubOff
          ? 'Magpie Hub is off in the Library: Hub-managed services are unavailable and their DSH entry stays retired. Turn the Hub back on, or remove this plugin\'s magpieHub takeover.'
          : hub?.libraryAbsent ? 'Magpie Library not found: no Hub-managed service is claimed; independent stdio servers are unaffected.' : null)
        return (((reloadError || hubNotice) ? `Configuration warning: ${reloadError ?? hubNotice}\n\n` : '') +
          (inventory ? `DSH MCP entries:\n${inventory}\n\n` : '') + (body || 'No on-demand MCP servers configured.')).slice(0, config.maxResultChars ?? 60000)
      },
    }))
    managementDisposers.push(ctx.tools.register({
      name: 'mcp_load',
      description: `Load or unload one MCP server only for the calling session. Servers: ${summarize(servers)}. When a task matches an available server, load it before using fallback access paths. Native tools become available on the next step. Service connections can be shared; loading grants tool visibility only to this session. Unloading or idle expiry releases this session's tools without interrupting other users.`,
      parameters: { type: 'object', properties: { server: { type: 'string', description: 'Exact MCP server name' }, action: { type: 'string', enum: ['load', 'unload'], description: 'Defaults to load; unload removes this session’s tools and releases its service reference' } }, required: ['server'], additionalProperties: false }, output: textOutput,
      async execute(args, exec) {
        const agent = caller(exec)
        await reloadDefinitions()
        const server = serverOf(args.server)
        const ldr = getLoader(ctx)
        const activeOfficial = new Set(
          (ldr?.entries ? [...ldr.entries()] : [])
            .filter(entry => entry.options?.name === '@deepseek-ai/dsh-mcp-client' && !entry.disabled)
            .map(entry => {
              try {
                const val = entry.options.config?.serverName
                return val?.__jsExpr ? entry.evaluate(val.__jsExpr) : val
              } catch { return null }
            }).filter(Boolean)
        )
        if (!server.hub && activeOfficial.has(server.serverName)) {
          throw new Error(`MCP server ${server.serverName} is already running as an official client; disable its entry in DSH to manage on-demand`)
        }
        if (server.hub) {
          if (args.action === 'unload') return hub.unload(agent, server.serverName) ? `Unloaded ${server.serverName} from this session; other sessions were not changed` : `${server.serverName} is not loaded in this session`
          const lease = await hub.load(agent, server.serverName, exec.signal)
          return `Loaded ${lease.registrations.size} tools from ${server.serverName} only in session ${agent.id}:\n${[...lease.registrations.keys()].join('\n')}`
        }
        if (args.action === 'unload') {
          const state = states.get(agent), lease = state?.leases.get(server.serverName)
          if (!lease) return `${server.serverName} is not loaded in this session`
          if (lease.active) throw new Error('MCP tool call is still running; unload after it completes')
          revoke(state, lease)
          return `Unloaded ${server.serverName} from this session; other sessions were not changed`
        }
        const lease = await load(agent, server, exec.signal)
        return `Loaded ${lease.registrations.size} tools from ${server.serverName} only in session ${agent.id}:\n${[...lease.registrations.keys()].join('\n')}`
      },
    }))
    managementDisposers.push(ctx.tools.register({
      name: 'mcp_refresh', description: 'Re-read the connection file, then refresh cached tool names without registering tools. Reuses a matching service connection and releases the temporary scan reference afterward.',
      parameters: { type: 'object', properties: { server: { type: 'string', description: 'Server name; omit to refresh all configured servers' } }, additionalProperties: false }, output: textOutput,
      async execute(args, exec) {
        const agent = caller(exec)
        await reloadDefinitions()
        const selected = args?.server ? [serverOf(args.server)] : servers
        const results = reloadError ? [`configuration: ${reloadError}`] : []
        for (const server of selected) {
          if (disposed || isArchived(agent) || exec.signal?.aborted || closedAgents.has(agent)) throw new Error('MCP refresh cancelled')
          try { results.push(`${server.serverName}: ${server.hub ? await hub.refresh(server.serverName, agent, exec?.signal) : await scan(server, exec?.signal, agent)} tools cached; scan reference released`) }
          catch (error) {
            if (disposed || isArchived(agent) || exec.signal?.aborted || closedAgents.has(agent)) throw new Error('MCP refresh cancelled')
            results.push(`${server.serverName}: failed — ${error.message}`)
          }
        }
        return results.join('\n')
      },
    }))
  }
  if (config.magpieHub?.enabled === true) {
    const retireDirect = async names => {
      for (const name of names) pools.markStale(name)
      for (const state of [...states.values()]) for (const lease of [...state.leases.values()]) if (names.has(lease.server.serverName)) { lease.stale = true; revoke(state, lease) }
      for (const [ref] of [...scans]) if (names.has(ref.pool.server.serverName)) { pools.release(ref); scans.delete(ref) }
      await pools.retire(names)
      if (hub) await hub.retireOfficial()
    }
    hub = new HubAdapter(ctx, config.magpieHub, {
      retireDirect, waitFor, live: agent => !disposed && !isArchived(agent) && !closedAgents.has(agent) && (!ctx.agents?.get || ctx.agents.get(agent.id) === agent),
      remember: async (name, tools, info) => {
        await cacheReady
        if (disposed) return
        catalog.servers[name] = { updatedAt: Date.now(), serverInfo: info ? { name: info.name, version: info.version } : null, tools: tools.map(tool => ({ name: tool.publicName, description: tool.description?.slice(0, 160) ?? '' })) }
        await persist()
      },
    })
    servers = [...servers.filter(server => !hub.owns(server.serverName)), ...hub.definitions()]
  }
  registerManagement()
  if (scanDsh || hub) {
    ctx.on('loader/config-update', () => reloadDefinitions())
    ctx.on('loader/partial-dispose', () => reloadDefinitions())
    ctx.on('ready', () => reloadDefinitions())
  }
  ctx.systemPrompt?.section({
    name: 'mcp-session-routing', order: 6900, interpolate: false,
    text: 'Use mcp_catalog to discover configured MCP capabilities. When the task matches a server, call mcp_load before its native tools or fallback access paths. Loading is session-local and allowed at any step. After idle expiry or session restore, load again when needed. A network failure is not a loading failure; report the actual error before falling back.',
  })
  ctx.on('domain/changed', change => {
    if (change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put' || !Array.isArray(change.value?.archivedSessionIds)) return
    archivedSessions = new Set(change.value.archivedSessionIds.map(String))
    for (const [ref, owner] of [...scans]) if (isArchived(owner)) { pools.release(ref); scans.delete(ref) }
    for (const [agent, state] of [...states]) if (isArchived(agent)) {
      for (const lease of [...state.leases.values()]) revoke(state, lease)
    }
    if (hub) for (const lease of hub.allLeases()) if (isArchived(lease.agent)) hub.revoke(lease)
  })
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || !Number.isSafeInteger(event.data?.turn) || event.data.turn < 1) return
    hub?.turn(session, event, inactiveTurns)
    const state = sessionStates.get(session)
    if (!state || state.closed) return
    for (const lease of [...state.leases.values()]) {
      if (lease.closed || event.data.turn <= lease.lastCompletedTurn) continue
      lease.lastCompletedTurn = event.data.turn
      lease.turnsSinceLastCall = lease.usedInTurn ? 0 : lease.turnsSinceLastCall + 1
      lease.usedInTurn = false
      const threshold = lease.server.inactiveTurnsThreshold ?? inactiveTurns
      if (lease.turnsSinceLastCall >= threshold) expire(state, lease)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => close(agent))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    hub?.idle(agent)
    const state = states.get(agent)
    if (state) {
      for (const lease of [...state.leases.values()]) {
        const threshold = lease.server.inactiveTurnsThreshold ?? inactiveTurns
        const turnExpired = (lease.turnsSinceLastCall ?? 0) >= threshold
        const isStale = lease.stale || lease.ref?.pool?.stale
        if ((lease.expired || turnExpired || isStale) && !lease.active && !lease.loading) expire(state, lease)
      }
    }
  })
  const cleanup = () => {
    if (disposed) return
    disposed = true
    for (const agent of [...states.keys()]) close(agent)
    for (const ref of scans.keys()) pools.release(ref)
    scans.clear()
    pools.dispose()
    return hub?.dispose().catch(() => ctx.logger?.warn?.('Hub disposal could not confirm ownership clearance; admission remains blocked'))
  }
  ctx.effect(() => cleanup, 'mcp-session-catalog: scoped resources')
  ctx.on('dispose', cleanup)
  // No startup scan: cached discovery is pure, servers are strictly demand-started.
}
