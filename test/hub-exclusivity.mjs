import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempArea, fakeStdio } from './hub-harness.mjs'
import { createFakeHub, hubTool, deadline, deferred } from './hub-fixture.mjs'

function worker() {
  const child = fork(fileURLToPath(new URL('./hub-host-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env })
  let sequence = 0, stderr = ''
  const pending = new Map(), exited = deferred()
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk })
  child.on('message', ({ id, result, error }) => { const p = pending.get(id); if (!p) return; pending.delete(id); error ? p.reject(new Error(error.stack ?? error.message)) : p.resolve(result) })
  child.once('exit', (code, signal) => { exited.resolve({ code, signal }); for (const p of pending.values()) p.reject(new Error(`Test Host exited (${code ?? signal}): ${stderr}`)); pending.clear() })
  const request = (op, args = {}) => { const id = ++sequence, p = deferred(); pending.set(id, p); child.send({ id, op, args }); return deadline(p.promise, `test Host ${op}`, 10000) }
  return { child, request, async close() { if (child.exitCode !== null || child.signalCode !== null) return; try { await request('close'); await deadline(exited.promise, 'test Host close') } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } } }
}
async function records(file) { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) }
async function waitTrace(file, predicate, label) {
  const gate = deferred()
  const inspect = async () => { try { const list = await records(file); if (predicate(list)) gate.resolve(list) } catch (e) { gate.reject(e) } }
  const watcher = watch(file, inspect)
  await inspect()
  try { return await deadline(gate.promise, label) } finally { watcher.close() }
}
function intervalsDoNotOverlap(trace, pids) {
  const firstHub = trace.find(e => e.source === 'hub' && e.event === 'request')
  assert.ok(firstHub, 'test must observe a real Hub request')
  for (const pid of pids) {
    const start = trace.find(e => e.source === 'direct' && e.pid === pid && e.event === 'process-start')
    const exit = trace.find(e => e.source === 'direct' && e.pid === pid && e.event === 'process-exit')
    assert.ok(start && exit, `Missing process interval for direct PID ${pid}`)
    assert.ok(BigInt(start.time) < BigInt(exit.time))
    assert.ok(BigInt(exit.time) < BigInt(firstHub.time), `direct PID ${pid} overlaps first Hub request`)
  }
  assert.ok(trace.some(e => e.event === 'tools/change'), 'registration timeline must be recorded')
}
let passed = 0, failed = 0
async function test(label, fn) { if (process.env.HUB_TEST_CASE && !label.includes(process.env.HUB_TEST_CASE)) return; try { await fn(); passed++; console.log('PASS', label) } catch (e) { failed++; console.error('FAIL', label, e.stack) } }

await test('separate Host processes retire ALL Hub-owned directs before first HTTP request', async () => {
  const area = await tempArea('cross-host'), traceFile = join(area.path, 'timeline.jsonl')
  await writeFile(traceFile, '')
  await area.library([])
  const hub = await createFakeHub({ traceFile, tools: [hubTool('obsidian__identity'), hubTool('github__identity')] })
  const a = worker(), b = worker(), pids = []
  const direct = serverName => ({ serverName, command: process.execPath, args: [fakeStdio], env: { TRACE_FILE: traceFile, SERVICE_NAME: serverName } })
  try {
    await Promise.all([a.request('init', { traceFile, hostName: 'Host-A', config: { ...area.config(hub.url), cacheFile: join(area.path, 'cache-A.json'), servers: [direct('obsidian')] } }), b.request('init', { traceFile, hostName: 'Host-B', config: { ...area.config(hub.url), cacheFile: join(area.path, 'cache-B.json'), servers: [direct('github')] } })])
    await Promise.all([a.request('run', { name: 'mcp_load', arguments: { server: 'obsidian' } }), b.request('run', { name: 'mcp_load', arguments: { server: 'github' } })])
    pids.push(JSON.parse(await a.request('run', { name: 'mcp__obsidian__identity' })).pid)
    pids.push(JSON.parse(await b.request('run', { name: 'mcp__github__identity' })).pid)
    assert.equal(hub.counters.requests, 0)
    await area.library(['obsidian', 'github'])
    await a.request('run', { name: 'mcp_load', arguments: { server: 'obsidian' } })
    const trace = await waitTrace(traceFile, list => pids.every(pid => list.some(e => e.pid === pid && e.event === 'process-exit')), 'all direct process exits')
    intervalsDoNotOverlap(trace, pids)
    const bSchemas = await b.request('schemas')
    assert.equal(bSchemas.some(t => t.name.startsWith('mcp__github__')), false)
  } finally {
    await Promise.allSettled([a.close(), b.close()]); await hub.close()
    // Only fake PIDs obtained from this test are cleanup targets.
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') throw e } }
    await area.cleanup()
  }
})

await test('Hub-owned direct duplicate never starts and Hub failure never falls back', async () => {
  const area = await tempArea('no-fallback'), traceFile = join(area.path, 'timeline.jsonl')
  await writeFile(traceFile, ''); await area.library(['obsidian'])
  const hub = await createFakeHub({ traceFile, tools: [hubTool('obsidian__identity')] })
  hub.setListError({ code: -32603, message: 'Hub unavailable ECONNRESET' })
  const host = worker()
  try {
    await host.request('init', { traceFile, hostName: 'Hub-priority', config: { ...area.config(hub.url), servers: [{ serverName: 'obsidian', command: process.execPath, args: [fakeStdio], env: { TRACE_FILE: traceFile, SERVICE_NAME: 'obsidian' } }] } })
    await assert.rejects(host.request('run', { name: 'mcp_load', arguments: { server: 'obsidian' } }))
    assert.ok(hub.counters.requests > 0)
    assert.equal((await records(traceFile)).some(e => e.source === 'direct' && e.event === 'process-start'), false)
    assert.deepEqual(await host.request('schemas'), [])
  } finally { await host.close(); await hub.close(); await area.cleanup() }
})
console.log(JSON.stringify({ suite: 'hub-exclusivity', passed, failed }))
if (failed) process.exitCode = 1
