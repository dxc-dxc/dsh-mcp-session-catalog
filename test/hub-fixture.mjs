import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'

export const stamp = () => process.hrtime.bigint().toString()
export function deferred() { const p = Promise.withResolvers(); p.promise.catch(() => {}); return p }
export function deadline(promise, label, ms = 5000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms) })]).finally(() => clearTimeout(timer))
}
export function traceEvent(file, event) {
  const record = { time: stamp(), pid: process.pid, ...event }
  if (file) appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

// Local Streamable HTTP MCP peer, independent of production's SDK.
export async function createFakeHub(options = {}) {
  const events = new EventEmitter(), trace = []
  const counters = { requests: 0, initialize: 0, list: 0, call: 0, get: 0, delete: 0, rejectedAuth: 0 }
  const calls = new Map(), sessions = new Set(), gates = new Map(), sockets = new Set(), responses = new Set()
  let tools = options.tools ?? [], serial = 0, listError = null, stopping = false
  const record = event => { const e = traceEvent(options.traceFile, { source: 'hub', ...event }); trace.push(e); events.emit('trace', e); return e }
  const pause = async (kind, detail) => { const g = gates.get(kind); if (g) { g.entered.resolve(detail); await g.release.promise } }
  const response = (res, message, method) => {
    if (res.destroyed || stopping) return
    const sse = options.responseMode === 'sse' || options.sseMethods?.includes(method)
    res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache' })
    res.end(sse ? `event: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message))
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8'), m = raw ? JSON.parse(raw) : null
      counters.requests++
      // No headers/arguments in traces; test evidence must be credential-free too.
      record({ event: 'request', method: m?.method ?? req.method, id: m?.id, tool: m?.params?.name, path: req.url })
      if (options.authorization && req.headers.authorization !== options.authorization) { counters.rejectedAuth++; res.writeHead(401); return res.end('Unauthorized') }
      if (req.method === 'GET') { counters.get++; res.writeHead(405, { allow: 'POST' }); return res.end() }
      if (req.method === 'DELETE') { counters.delete++; sessions.delete(req.headers['mcp-session-id']); res.writeHead(200); return res.end() }
      if (!m?.method) { res.writeHead(400); return res.end() }
      if (m.id === undefined) { record({ event: 'notification', method: m.method, requestId: m.params?.requestId }); res.writeHead(202); return res.end() }
      const method = m.method
      responses.add(res); res.once('close', () => responses.delete(res))
      let result, error
      if (method === 'initialize') {
        counters.initialize++; await pause('initialize', m)
        const session = `fixture-${++serial}`; sessions.add(session); res.setHeader('mcp-session-id', session)
        result = { protocolVersion: m.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake-magpie-hub', version: '1' } }
      } else if (method === 'tools/list') {
        counters.list++; await pause('list', m)
        if (listError) error = listError
        else { const start = Number(m.params?.cursor ?? 0), end = start + (options.pageSize ?? Math.max(tools.length, 1)); result = { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: String(end) } : {}) }; if (options.repeatCursor) result.nextCursor = '0' }
      } else if (method === 'tools/call') {
        counters.call++; const tool = m.params.name, count = (calls.get(tool) ?? 0) + 1; calls.set(tool, count)
        await pause(`call:${tool}`, m); await pause('call', m)
        const custom = await options.call?.(tool, m.params.arguments ?? {}, { count, counters, session: req.headers['mcp-session-id'] })
        if (custom?.rpcError) error = custom.rpcError
        else result = custom ?? { content: [{ type: 'text', text: JSON.stringify({ tool, count, connection: req.headers['mcp-session-id'] }) }] }
      } else if (method === 'ping') result = {}
      else error = { code: -32601, message: 'Unknown method' }
      record({ event: 'response', method, id: m.id, tool: m.params?.name, failed: Boolean(error) })
      response(res, { jsonrpc: '2.0', id: m.id, ...(error ? { error } : { result }) }, method)
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end('fixture request failed') }; record({ event: 'fixture-error', message: error.message }) }
  })
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp/magpie/hub/dsh`, trace, counters, calls, sessions,
    waitFor(predicate, label = 'Hub event', ms = 5000) {
      const prior = trace.find(predicate); if (prior) return Promise.resolve(prior)
      let listener
      return deadline(new Promise(resolve => { listener = e => { if (predicate(e)) resolve(e) }; events.on('trace', listener) }), label, ms).finally(() => events.off('trace', listener))
    },
    setTools(next) { tools = next }, setListError(error) { listError = error },
    hold(kind) { if (gates.has(kind)) throw new Error(`Duplicate gate: ${kind}`); const g = { entered: deferred(), release: deferred() }; gates.set(kind, g); return { entered: g.entered.promise, release() { gates.delete(kind); g.release.resolve() } } },
    async close() { stopping = true; for (const g of gates.values()) g.release.resolve(); gates.clear(); for (const r of responses) r.destroy(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); events.removeAllListeners() },
  }
}
export function hubTool(name, extra = {}) { return { name, description: `Fixture ${name}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, ...extra } }
