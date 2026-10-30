import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const trace = event => { if (process.env.TRACE_FILE) appendFileSync(process.env.TRACE_FILE, JSON.stringify({ time: process.hrtime.bigint().toString(), pid: process.pid, source: 'direct', service: process.env.SERVICE_NAME, ...event }) + '\n') }
trace({ event: 'process-start' })
process.once('exit', () => trace({ event: 'process-exit' }))
process.once('SIGTERM', () => process.exit(0))
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  let m; try { m = JSON.parse(line) } catch { continue }
  trace({ event: 'request', method: m.method })
  if (m.id === undefined) continue
  if (m.method === 'initialize') send(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'trace-only-fake', version: '1' } })
  else if (m.method === 'tools/list') send(m.id, { tools: [{ name: 'identity', description: 'Fake process identity', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] })
  else if (m.method === 'tools/call') send(m.id, { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid }) }] })
}
