// A pool owns the transport. A session lease owns only scoped registrations.
// No application/tool names belong here. Shared pools are keyed by configured
// connection identity (serverName); explicit session mode uses exact Agent keys.
export class ConnectionPool {
  constructor(createConnection, waitFor, shouldRetry = () => false, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.shouldRetry = shouldRetry
    this.pause = pause
    this.createConnection = createConnection
    this.waitFor = waitFor
    this.shared = new Map()
    this.sessions = new WeakMap()
    this.all = new Set()
    this.disposed = false
    this.closing = new Set()
  }
  acquire(server, agent, kind = 'lease') {
    if (this.disposed) throw new Error('MCP pool disposed')
    const shared = server.sharing !== 'session'
    let directory = this.shared
    if (!shared) {
      directory = this.sessions.get(agent)
      if (!directory) { directory = new Map(); this.sessions.set(agent, directory) }
    }
    let pool = directory.get(server.serverName)
    if (pool?.stale) pool = undefined
    if (!pool || pool.closed) {
      pool = { server, directory, connection: this.createConnection(server), refs: new Set(), calls: 0, discovery: null, tools: null, closed: false }
      directory.set(server.serverName, pool)
      this.all.add(pool)
    }
    // Acquired synchronously, before discovery/initialization can yield.
    const ref = { pool, agent, kind, released: false }
    pool.refs.add(ref)
    return ref
  }
  assertRef(ref) {
    if (this.disposed || ref.released || ref.pool.closed || ref.pool.stale) throw new Error('MCP pool reference released')
  }
  async tools(ref, force = false, signal) {
    this.assertRef(ref)
    const pool = ref.pool
    if (!force && pool.tools) return pool.tools
    if (!pool.discovery) {
      const discover = (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const tools = await pool.connection.listTools()
            if (pool.closed) throw new Error('MCP pool closed during discovery')
            pool.tools = tools
            return tools
          } catch (error) {
            if (pool.closed || pool.stale || attempt >= 1 || !this.shouldRetry(error)) throw error
            await this.pause(300)
            if (pool.closed) throw new Error('MCP pool closed during discovery')
          }
        }
      })()
      const pending = discover.finally(() => { if (pool.discovery === pending) pool.discovery = null })
      pool.discovery = pending
    }
    // Cancellation belongs to the waiter, never to shared initialization.
    const tools = await this.waitFor(pool.discovery, signal)
    this.assertRef(ref)
    return tools
  }
  async call(ref, name, args, signal) {
    this.assertRef(ref)
    const pool = ref.pool
    pool.calls++
    try { return await pool.connection.call(name, args, signal) }
    finally { pool.calls--; this.maybeClose(pool) }
  }
  release(ref) {
    if (ref.released) return
    ref.released = true
    ref.pool.refs.delete(ref)
    this.maybeClose(ref.pool)
  }
  // A configuration change retires the current transport for one server: new
  // loads build a fresh pool, while holders keep working until they release.
  markStale(serverName) {
    for (const pool of [...this.all]) {
      if (pool.closed || pool.server.serverName !== serverName) continue
      if (!pool.refs.size && !pool.calls) { this.close(pool); continue }
      pool.stale = true
    }
  }
  maybeClose(pool) {
    // Existing business calls are operation references. Discovery can be cancelled
    // when its final consumer goes away; there are no submitted business effects.
    if (pool.closed || pool.refs.size || pool.calls) return
    this.close(pool)
  }
  close(pool) {
    if (pool.closed) return
    pool.closed = true
    if (pool.directory.get(pool.server.serverName) === pool) pool.directory.delete(pool.server.serverName)
    this.all.delete(pool)
    const closing = Promise.resolve(pool.connection.dispose())
    this.closing.add(closing)
    closing.finally(() => this.closing.delete(closing)).catch(() => {})
  }
  async retire(names) {
    const selected = [...this.all].filter(pool => names.has(pool.server.serverName))
    for (const pool of selected) {
      pool.stale = true
      for (const ref of [...pool.refs]) this.release(ref)
    }
    const deadline = Date.now() + 10000
    while (selected.some(pool => pool.calls)) {
      if (Date.now() > deadline) throw new Error('Hub direct retirement is waiting for in-flight calls')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    for (const pool of selected) this.close(pool)
    await Promise.all([...this.closing])
  }
  async settled() { await Promise.all([...this.closing]) }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const pool of [...this.all]) {
      if (pool.calls) {
        pool.stale = true
        const timer = setTimeout(() => this.close(pool), 5000)
        timer.unref?.()
      } else {
        this.close(pool)
      }
    }
    this.shared.clear()
  }
}
