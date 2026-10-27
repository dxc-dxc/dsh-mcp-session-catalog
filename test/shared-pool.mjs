import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.mjs'
const base=process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the @deepseek-ai directory in the target DSH installation')
const dshImport=path=>pathToFileURL(join(base,path)).href
const {Context}=await import(dshImport('cordis/lib/index.js'))
const {default:Tools}=await import(dshImport('dsh-tools/lib/index.js'))
const {default:SystemPrompt}=await import(dshImport('dsh-system-prompt/lib/index.js'))
const {createScope}=await import(dshImport('dsh-scope/lib/index.js'))
const temp=await mkdtemp(join(tmpdir(),'mcp-shared-pool-'))
const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx)
const scopes=[]
const agent=id=>{const a={id,session:{id},status:'idle'},s=createScope(ctx,a);a.ctx=s.ctx;scopes.push(s);return a}
const a=agent('A'),b=agent('B'),c=agent('C'),d=agent('D'),e=agent('E'),f=agent('F')
const signal=new AbortController().signal
const run=(who,name,args={},sig=signal)=>ctx.tools.get(name,who).execute(args,{agent:who,signal:sig})
const load=(who,server)=>run(who,'mcp_load',{server})
const unload=(who,server)=>run(who,'mcp_load',{server,action:'unload'})
const identity=async(who,server)=>JSON.parse(await run(who,`mcp__${server}__identity`))
const count=who=>ctx.tools.schemas(who).filter(t=>t.name.startsWith('mcp__')).length
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}
const archive=ids=>ctx.emit('domain/changed',{domain:'workspace',table:'',operation:'put',value:{archivedSessionIds:ids}})
const fake=fileURLToPath(new URL('./fake-server.mjs',import.meta.url))
const definition=(serverName,extras={})=>({serverName,command:process.execPath,args:[fake],...extras})
const marker=join(temp,'never-started')
const servers=[definition('shared'),definition('delayed',{env:{START_DELAY_MS:'220'}}),definition('unreached',{env:{START_MARKER:marker}}),definition('isolated',{sharing:'session'}),definition('single')]
let passed=0
const ok=message=>{passed++;console.log('PASS',message)}
apply(ctx,{cacheFile:join(temp,'cache.json'),inactiveTurnsThreshold:20,servers})
try {
 await Promise.all([load(a,'shared'),load(b,'shared')])
 const first=await identity(a,'shared'),second=await identity(b,'shared')
 assert.equal(first.pid,second.pid);assert.equal(first.initializes,1);assert.equal(first.lists,1)
 assert.equal(count(),0);assert.equal(count(c),0)
 ok('cross-Agent cold loads use one process, one initialize and one tools/list')
 const denied=await ctx.tools.execute({agent:c,name:'mcp__shared__identity',arguments:{},signal,callId:'unloaded-C'})
 assert.equal(denied.isError,true);ok('C cannot invoke a shared tool before acquiring its own scope')
 await run(c,'mcp_refresh',{server:'shared'})
 assert.equal(count(c),0);const refreshed=await identity(b,'shared')
 assert.equal(refreshed.pid,first.pid);assert.equal(refreshed.lists,2)
 ok('refresh reuses the live shared connection without granting native schemas')
 await unload(a,'shared');assert.equal(count(a),0);assert.equal((await identity(b,'shared')).pid,first.pid)
 ok('A unload preserves B schemas and a callable original process')
 await load(a,'shared')
 const abortCall=new AbortController()
 const slow=run(a,'mcp__shared__slow',{ms:180},abortCall.signal).then(()=>null,error=>error)
 await sleep(25);abortCall.abort();assert.ok(await slow)
 assert.equal((await identity(b,'shared')).pid,first.pid);await sleep(200)
 assert.equal((await identity(b,'shared')).pid,first.pid)
 ok('cancelling A RPC does not cancel B RPC or the shared transport')
 await unload(a,'shared')
 const abortLoad=new AbortController()
 const loadingD=run(d,'mcp_load',{server:'delayed'},abortLoad.signal).then(()=>null,error=>error)
 const loadingE=load(e,'delayed')
 await sleep(25);abortLoad.abort();assert.ok(await loadingD);await loadingE
 assert.equal(count(d),0);const delayed=await identity(e,'delayed')
 assert.equal(delayed.initializes,1);assert.equal(delayed.lists,1)
 ok('cancelling the first Agent load does not poison a second Agent initialization')
 await unload(e,'delayed');await sleep(60);assert.equal(alive(delayed.pid),false)
 const scanning=run(d,'mcp_refresh',{server:'delayed'}).then(()=>null,error=>error)
 const joining=load(e,'delayed')
 await sleep(25);archive([d.id]);assert.ok(await scanning);await joining
 const scanJoin=await identity(e,'delayed');assert.equal(scanJoin.initializes,1);assert.equal(scanJoin.lists,1)
 assert.equal(count(d),0);assert.equal(count(e),4)
 await assert.rejects(load(d,'delayed'),/unarchived/)
 ok('archiving a scan-only Agent releases its ref but preserves another Agent load')
 archive([]);await load(d,'delayed');assert.equal((await identity(d,'delayed')).pid,scanJoin.pid)
 await unload(d,'delayed');await unload(e,'delayed')
 ok('unarchive permits a fresh scoped load on the existing shared service')
 const allScan=run(d,'mcp_refresh',{}).then(()=>null,error=>error)
 await sleep(60);archive([d.id]);assert.ok(await allScan);await sleep(260)
 await assert.rejects(access(marker));ok('archiving refresh-all stops later process starts without a polling loop')
 archive([])
 await load(f,'single');const only=await identity(f,'single')
 const inFlight=run(f,'mcp__single__slow',{ms:160})
 await sleep(25);ctx.emit('agent/disposed',{agent:f});assert.equal(count(f),0);assert.equal(alive(only.pid),true)
 await inFlight;await sleep(60);assert.equal(alive(only.pid),false)
 ok('an in-flight RPC holds the final operation reference after Agent disposal')
 await Promise.all([load(a,'isolated'),load(c,'isolated')])
 const isoA=await identity(a,'isolated'),isoC=await identity(c,'isolated')
 assert.notEqual(isoA.pid,isoC.pid);await unload(a,'isolated')
 assert.equal((await identity(c,'isolated')).pid,isoC.pid);await unload(c,'isolated')
 ok('explicit session sharing mode still isolates backend state when configured')
 await unload(b,'shared');await sleep(60);assert.equal(alive(first.pid),false)
 await load(a,'shared');const replacement=await identity(a,'shared');assert.notEqual(replacement.pid,first.pid)
 await unload(a,'shared');await sleep(60);assert.equal(alive(replacement.pid),false)
 ok('final release terminates the process; a later explicit load starts a new generation')
 assert.throws(()=>apply(new Context(),{servers,idleTimeoutMs:1}),/retired/)
 assert.throws(()=>apply(new Context(),{servers:[definition('retired',{serviceIdleTimeoutMs:null})]}),/retired/)
 ok('retired wall-clock and persistent options cannot override immediate-close policy')
 assert.equal(count(a)+count(b)+count(c)+count(d)+count(e)+count(f),0)
 console.log(JSON.stringify({passed,globalNativeSchemas:count()}))
}finally{
 ctx.emit('dispose')
 for(const scope of scopes)await scope.dispose()
 const { realpath, rm } = await import('node:fs/promises')
 const { dirname } = await import('node:path')
 const resolved = await realpath(temp)
 assert.equal(dirname(resolved), await realpath(tmpdir()))
 await rm(resolved, { recursive: true, force: true })
}
