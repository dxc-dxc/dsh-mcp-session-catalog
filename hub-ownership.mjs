import { createHash, randomUUID } from 'node:crypto'
import { watch, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync, fsyncSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fresh = () => ({ protocol: 1, revision: 0, claims: {}, hosts: {} })

// A crashed/old participant is never evicted by PID or mtime: children may live.
export class HubOwnership {
  constructor(directory, retire) {
    if (typeof directory !== 'string' || !directory) throw new Error('magpieHub.ownershipDir is required')
    this.directory = resolve(directory)
    this.file = join(this.directory, 'ownership.json')
    this.lock = join(this.directory, 'ownership.lock')
    this.id = randomUUID()
    this.retire = retire
    this.closed = false
    this.queue = Promise.resolve()
    this.running = null
    this.error = null
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.ready = this.transaction(state => {
      state.hosts[this.id] = { protocol: 1, pid: process.pid, status: 'active', ack: -1, direct: {}, desired: {} }
    }).then(() => this.reconcile())
    this.ready.catch(() => { this.error = 'Hub ownership registration failed' })
    this.watcher = watch(this.directory, (_event, file) => {
      if (file && String(file) !== 'ownership.json') return
      this.reconcile().catch(() => { this.error = 'Hub ownership reconciliation failed' })
    })
    this.watcher.unref?.()
  }
  pathInRegistry(path) {
    const absolute = resolve(path)
    if (dirname(absolute) !== this.directory) throw new Error('Invalid ownership registry path')
    return absolute
  }
  read() {
    let state
    try { state = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return fresh(); throw new Error('Hub ownership registry unreadable; admission blocked') }
    if (state?.protocol !== 1 || !Number.isSafeInteger(state.revision) || !state.claims || !state.hosts || Array.isArray(state.claims) || Array.isArray(state.hosts)) throw new Error('Unknown Hub ownership protocol; admission blocked')
    for (const host of Object.values(state.hosts)) {
      if (host.protocol !== 1 || !['active', 'closed'].includes(host.status) || !host.direct || !Number.isInteger(host.ack)) throw new Error('Unknown Hub ownership participant; admission blocked')
    }
    return state
  }
  // A Host killed inside a transaction leaves the mutex behind. The lock names
  // its holder, so a dead holder (or one far older than any transaction may
  // run) is reclaimed instead of blocking every later Host forever.
  reclaimStaleLock() {
    let holder = NaN, age
    try {
      holder = Number(readFileSync(this.lock, 'utf8').trim())
      age = Date.now() - statSync(this.lock).mtimeMs
    } catch { return false }
    if (Number.isSafeInteger(holder) && holder > 1) {
      try { process.kill(holder, 0); return false }
      catch (error) { if (error.code !== 'ESRCH') return false }
    }
    if (!(age > 10000)) return false
    try { unlinkSync(this.pathInRegistry(this.lock)); return true } catch { return false }
  }
  transaction(change) {
    const task = this.queue.catch(() => {}).then(async () => {
      const deadline = Date.now() + 1500
      let fd
      while (fd === undefined) {
        try { fd = openSync(this.lock, 'wx', 0o600) }
        catch (error) {
          if (error.code !== 'EEXIST') throw this.unavailable(`registry is unwritable (${error.code ?? error.message})`)
          if (this.reclaimStaleLock()) continue
          if (Date.now() >= deadline) throw this.unavailable('registry is locked by another DSH Host')
          await sleep(20)
        }
      }
      try {
        writeFileSync(fd, String(process.pid))
        const state = this.read()
        change(state)
        const temp = this.pathInRegistry(join(this.directory, `ownership.${this.id}.tmp`))
        const out = openSync(temp, 'w', 0o600)
        try { writeFileSync(out, JSON.stringify(state)); fsyncSync(out) } finally { closeSync(out) }
        renameSync(this.pathInRegistry(temp), this.pathInRegistry(this.file))
        return state
      } finally {
        closeSync(fd)
        unlinkSync(this.pathInRegistry(this.lock))
      }
    })
    this.queue = task
    return task
  }
  reconcile() {
    if (this.closed) return Promise.resolve()
    if (this.running) { this.rerun = true; return this.running }
    const task = (async () => {
      do {
        this.rerun = false
        const state = this.read(), host = state.hosts[this.id]
        if (!host) throw new Error('Hub ownership participant disappeared')
        const names = Object.keys(state.claims)
        if (host.ack === state.revision && !Object.keys(host.direct).some(key => names.includes(host.direct[key].server))) continue
        await this.retire(new Set(names), new Set(names.filter(name => state.claims[name].phase === 'releasing')))
        await this.transaction(current => {
          const own = current.hosts[this.id]
          if (current.revision !== state.revision) { this.rerun = true; return }
          if (Object.values(own.direct).some(value => current.claims[value.server])) throw new Error('Direct process exit has not been confirmed')
          own.ack = current.revision
          const participants = Object.values(current.hosts).filter(host => host.status !== 'closed')
          if (participants.every(host => host.ack === current.revision)) {
            const releasing = Object.keys(current.claims).filter(name => current.claims[name].phase === 'releasing')
            for (const name of releasing) delete current.claims[name]
            if (releasing.length) { current.revision++; this.rerun = true }
          }
        })
      } while (this.rerun && !this.closed)
      this.error = null
    })()
    this.running = task
    task.finally(() => { if (this.running === task) this.running = null }).catch(() => {})
    return task
  }
  async claim(services) {
    await this.ready
    await this.transaction(state => {
      state.hosts[this.id].desired = Object.fromEntries(services.map(service => [service.name, digest(service)]))
      this.deriveClaims(state)
    })
    await this.reconcile()
  }
  deriveClaims(state) {
    const desired = new Map()
    for (const host of Object.values(state.hosts)) {
      if (host.status === 'closed') continue
      if (!host.desired || Array.isArray(host.desired)) throw new Error('Unknown ownership participant intent; admission blocked')
      for (const [name, identity] of Object.entries(host.desired)) {
        const identities = desired.get(name) ?? new Set()
        identities.add(identity); desired.set(name, identities)
      }
    }
    let changed = false
    for (const [name, identities] of desired) {
      const identity = digest([...identities].sort())
      if (state.claims[name]?.identity !== identity || state.claims[name]?.phase !== 'owned') {
        state.claims[name] = { identity, phase: 'owned' }; changed = true
      }
    }
    for (const name of Object.keys(state.claims)) if (!desired.has(name) && state.claims[name].phase !== 'releasing') {
      state.claims[name].phase = 'releasing'; changed = true
    }
    if (changed) state.revision++
  }
  unavailable(why) {
    return new Error(`Hub ownership ${why}; independent stdio start is blocked to prevent a duplicate backend. Retry, and if no other DSH Host is running remove ${this.lock}`)
  }
  assertDirect(server) {
    if (this.closed) throw new Error('Hub ownership manager disposed')
    if (this.error) throw this.unavailable(`is unavailable (${this.error})`)
    if (this.read().claims[server]) throw new Error('MCP service is Hub-owned; direct startup and retry are blocked')
  }
  async enterDirect(server, token) {
    await this.ready
    if (this.closed) throw new Error('Hub ownership manager disposed')
    if (this.error) throw this.unavailable(`is unavailable (${this.error})`)
    await this.transaction(state => {
      if (state.claims[server]) throw new Error('MCP service is Hub-owned; direct startup is blocked')
      state.hosts[this.id].direct[token] = { server, phase: 'starting' }
    })
  }
  async exitDirect(token) {
    await this.transaction(state => { delete state.hosts[this.id]?.direct[token] })
  }
  async barrier(signal) {
    await this.ready
    await this.reconcile()
    const deadline = Date.now() + 5000
    for (;;) {
      if (signal?.aborted) throw new Error('MCP call aborted')
      if (this.closed || this.error) throw new Error('Hub ownership unavailable; admission blocked')
      const state = this.read()
      const pending = Object.values(state.hosts).some(host => host.status !== 'closed' && (host.ack !== state.revision || Object.values(host.direct).some(value => state.claims[value.server])))
      if (!pending) return state.revision
      if (Date.now() >= deadline) throw new Error('Hub blocked: another Host has not confirmed all Hub-owned direct processes retired')
      await sleep(20)
    }
  }
  async dispose() {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      this.watcher.close()
      await this.ready.catch(() => {})
      await this.running?.catch(() => {})
      this.closed = true
      await this.transaction(state => {
        const host = state.hosts[this.id]
        if (!host) return
        if (Object.keys(host.direct).length) throw new Error('Host shutdown did not confirm direct process exit')
        host.status = 'closed'; host.ack = state.revision
        host.desired = {}
        this.deriveClaims(state)
      })
    })()
    return this.stopping
  }
}
