const abortable = (promise, signal) => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('MCP call aborted'))
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('MCP call aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
const safeError = error => {
  if (error?.name === 'AbortError' || /abort|cancel/i.test(error?.message ?? '')) return new Error('MCP Hub request aborted')
  if (/timeout|timed out/i.test(error?.message ?? '')) return new Error('MCP Hub request timed out; no automatic replay')
  const status = error?.code ?? error?.status
  return new Error(`MCP Hub request failed${typeof status === 'number' ? ` (${status})` : ''}; no direct fallback or automatic replay`)
}

// SDK loading is demand-only. Creating, cataloging or resuming a Host never
// imports it, connects, probes, pings or submits any request.
export class HttpConnection {
  constructor(server, beforeRequest = async () => {}, changed = () => {}) {
    this.server = server
    this.beforeRequest = beforeRequest
    this.changed = changed
    this.closed = false
    this.client = null
    this.ready = null
    this.serverInfo = null
  }
  ensure() {
    if (this.closed) return Promise.reject(new Error('MCP Hub connection disposed'))
    if (!this.ready) {
      const ready = this.start()
      this.ready = ready
      ready.catch(() => { if (this.ready === ready) this.ready = null })
    }
    return this.ready
  }
  async start() {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
    if (this.closed) throw new Error('MCP Hub connection disposed')
    await this.beforeRequest()
    if (this.closed) throw new Error('MCP Hub connection disposed')
    const client = new Client({ name: 'dsh-mcp-session-catalog', version: '2.5.0' }, {
      capabilities: {}, versionNegotiation: { mode: 'legacy' },
      inputRequired: { autoFulfill: false }, listMaxPages: 100,
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => this.changed() } },
    })
    this.client = client
    const transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
      requestInit: { headers: this.server.headers ?? {}, redirect: 'error' },
      reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
      onInsufficientScope: 'throw', maxStepUpRetries: 0,
      fetch: async (url, init) => {
        await this.beforeRequest(init?.signal)
        if (this.closed || this.client !== client) throw new Error('MCP Hub generation retired')
        // Static headers only: no OAuth re-auth retries, no redirect forwarding.
        return fetch(url, { ...init, redirect: 'error' })
      },
    })
    try {
      await client.connect(transport, { timeout: this.server.connectTimeoutMs ?? 30000 })
      if (this.closed || this.client !== client) throw new Error('MCP Hub generation retired')
      this.serverInfo = client.getServerVersion() ?? null
    } catch (error) {
      if (this.client === client) this.client = null
      await client.close().catch(() => {})
      throw safeError(error)
    }
  }
  async listTools(signal) {
    await abortable(this.ensure(), signal)
    if (this.closed) throw new Error('MCP Hub connection disposed')
    try {
      const response = await this.client.listTools(undefined, { signal, timeout: this.server.toolCallTimeoutMs ?? 60000, cacheMode: 'refresh' })
      if (this.closed) throw new Error('MCP Hub generation retired')
      return response.tools
    } catch (error) { throw safeError(error) }
  }
  async call(tool, args, signal, definition) {
    // No reconnect or business replay. Only a new explicit load/refresh may
    // construct another physical client after a failure.
    if (this.closed || !this.client || !this.ready) throw new Error('MCP Hub is disconnected; explicitly load or refresh again')
    try {
      return await this.client.callTool({ name: tool, arguments: args ?? {} }, {
        signal, timeout: this.server.toolCallTimeoutMs ?? 60000, toolDefinition: definition,
      })
    } catch (error) { throw safeError(error) }
  }
  async dispose() {
    if (this.stopping) return this.stopping
    this.closed = true
    const client = this.client
    this.client = null
    // close() only aborts this HTTP transport. Never DELETE/terminateSession.
    this.stopping = (async () => {
      await client?.close().catch(() => {})
      await this.ready?.catch(() => {})
    })()
    return this.stopping
  }
}
