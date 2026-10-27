import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Connection } from '../index.mjs'
const base=process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the @deepseek-ai directory in the target DSH installation')
const dshImport=path=>pathToFileURL(join(base,path)).href
const {Context}=await import(dshImport('cordis/lib/index.js'))
const {default:SystemPrompt}=await import(dshImport('dsh-system-prompt/lib/index.js'))
const {default:Tools}=await import(dshImport('dsh-tools/lib/index.js'))
const {default:Agents}=await import(dshImport('dsh-agent/lib/index.js'))
const {createScope}=await import(dshImport('dsh-scope/lib/index.js'))
const temp=await mkdtemp(join(tmpdir(),'mcp-session-tests-'))
const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx)
const scopes=[], agents=[]
function agent(id){const a={id,session:{id},status:'idle'},s=createScope(ctx,a);a.ctx=s.ctx;scopes.push(s);agents.push(a);return a}
const a=agent('A'),b=agent('B'),restored=agent('restored-A'),fork=agent('fork-A')
const signal=new AbortController().signal
const counts=who=>ctx.tools.schemas(who).filter(t=>t.name.startsWith('mcp__')).length
const direct=(name,args,who=a)=>ctx.tools.get(name,who).execute(args??{},{agent:who,signal})
let n=0
const dispatch=(name,args,who=a)=>ctx.tools.execute({name,arguments:args??{},agent:who,signal,callId:`test-${++n}`})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const turns=new WeakMap()
function endTurn(who,count=1){for(let i=0;i<count;i++){const turn=(turns.get(who)??0)+1;turns.set(who,turn);ctx.emit('session/event',who.session,{type:'turn/end',data:{turn,reason:{kind:'completed'}}})}}
const passes=[]
function ok(label){passes.push(label);console.log('PASS',label)}
apply(ctx,{inactiveTurnsThreshold:20,cacheFile:join(temp,'cache.json'),servers:[{serverName:'demo',command:process.execPath,args:[fileURLToPath(new URL('./fake-server.mjs',import.meta.url))]},{serverName:'delayed',command:process.execPath,args:[fileURLToPath(new URL('./fake-server.mjs',import.meta.url))],env:{START_DELAY_MS:'200'}},{serverName:'unreached',command:process.execPath,args:[fileURLToPath(new URL('./fake-server.mjs',import.meta.url))],env:{START_MARKER:join(temp,'unreached')}}]})
try {
 assert.equal(counts(),0);assert.equal(counts(a),0);assert.equal(counts(b),0);ok('startup: no native MCP schemas')
 await Promise.all(Array.from({length:5},()=>direct('mcp_load',{server:'demo'})))
 assert.equal(counts(),0);assert.equal(counts(a),4);assert.equal(counts(b),0);ok('concurrent load: caller scope only, no duplicates')
 assert.equal((await dispatch('mcp__demo__identity',{},b)).isError,true)
 assert.equal((await dispatch('mcp__demo__identity',{})).isError,false);ok('real dispatcher rejects unrelated caller')
 assert.equal(await direct('mcp__demo__slow',{ms:-1}),'embedded file content');ok('embedded resource text is preserved')
 const assembly=await ctx.systemPrompt.assemble({scope:b});assert.equal(assembly.tools.filter(x=>x.name.startsWith('mcp__')).length,0);ok('unrelated assembled model tools stay empty')
 assert.equal(counts(restored),0);assert.equal(counts(fork),0);ok('resumed/forked identity does not inherit native registrations')
 const pidA=JSON.parse(await direct('mcp__demo__identity',{})).pid
 await direct('mcp_load',{server:'demo'},b)
 const pidB=JSON.parse(await direct('mcp__demo__identity',{},b)).pid
 assert.equal(pidA,pidB);ok('separate agents share one server process after explicit load')
 await direct('mcp_load',{server:'demo',action:'unload'})
 assert.equal(counts(a),0);assert.equal(counts(b),4);ok('explicit unload does not change another agent')
 await sleep(160);assert.equal(counts(b),4);ok('elapsed idle time alone does not revoke session tools')
 endTurn(b)
 endTurn(b,19);assert.equal(counts(b),4)
 endTurn(b);assert.equal(counts(b),0)
 const pidAlive=pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}}
 await sleep(50);assert.equal(pidAlive(pidB),false);ok('20 unused turns remove scopes and final shared process')
 const fakePath=fileURLToPath(new URL('./fake-server.mjs',import.meta.url))
 const launcher=`require('node:child_process').spawn(process.execPath,[${JSON.stringify(fakePath)}],{stdio:'inherit',env:{...process.env,IGNORE_TERM:'1'}})`
 const tree=new Connection({serverName:'tree',command:process.execPath,args:['-e',launcher]})
 try {
  await tree.listTools();const grandchild=JSON.parse((await tree.call('identity',{})).content[0].text).pid
  tree.dispose();await sleep(2300);assert.equal(pidAlive(grandchild),false);ok('bounded process-group cleanup kills stubborn grandchildren')
 } finally {tree.dispose()}
 await direct('mcp_load',{server:'demo'})
 a.status='running';endTurn(a,20);assert.equal(counts(a),4)
 a.status='idle';ctx.emit('agent/status',{agent:a,status:'idle'});assert.equal(counts(a),0);ok('turn expiry waits until active model turn is idle')
 await direct('mcp_load',{server:'demo'})
 const slow=direct('mcp__demo__slow',{ms:250});await sleep(160);assert.equal(counts(a),4);await slow;ok('idle timer never kills an active MCP RPC')
 a.status='running'
 const read=JSON.parse(await direct('mcp__demo__flaky_read',{}));assert.equal(read.reads,3);ok('transient read failures retry finitely')
 await assert.rejects(direct('mcp__demo__flaky_write',{}),/write_attempt=1/);ok('write failures are never automatically retried')
 a.status='idle'
 const pending=direct('mcp_load',{server:'delayed'}).then(()=>null,e=>e)
 await sleep(50);await direct('mcp_load',{server:'delayed',action:'unload'});assert.ok(await pending);assert.equal(ctx.tools.get('mcp__delayed__identity',a),undefined);ok('unload during initialization cannot resurrect registrations')
 const ctl=new AbortController()
 const first=ctx.tools.get('mcp_load').execute({server:'delayed'},{agent:a,signal:ctl.signal}).then(()=>null,e=>e)
 const second=direct('mcp_load',{server:'delayed'})
 await sleep(25);ctl.abort();assert.ok(await first);await second
 assert.ok(ctx.tools.get('mcp__delayed__identity',a));ok('one cancelled waiter does not poison concurrent load')
 await direct('mcp_load',{server:'delayed',action:'unload'})
 const singleCtl=new AbortController()
 const single=ctx.tools.get('mcp_load').execute({server:'delayed'},{agent:a,signal:singleCtl.signal}).then(()=>null,e=>e)
 await sleep(25);singleCtl.abort();assert.ok(await single);await sleep(250)
 assert.equal(ctx.tools.get('mcp__delayed__identity',a),undefined);ok('sole cancelled waiter stops loading without resurrection')
 const refreshCtl=new AbortController()
 const refresh=ctx.tools.get('mcp_refresh').execute({},{agent:a,signal:refreshCtl.signal}).then(()=>null,e=>e)
 await sleep(60);refreshCtl.abort();assert.ok(await refresh);await sleep(250)
 await assert.rejects(access(join(temp,'unreached')));ok('aborted refresh does not start later servers')
 await direct('mcp_load',{server:'demo',action:'unload'})
 const archA=agent('arch-A'), archB=agent('arch-B')
 await direct('mcp_load',{server:'demo'},archA)
 await direct('mcp_load',{server:'demo'},archB)
 const pidArch=JSON.parse(await direct('mcp__demo__identity',{},archA)).pid
 assert.equal(pidAlive(pidArch),true)
 ctx.emit('domain/changed',{domain:'workspace',table:'',operation:'put',value:{archivedSessionIds:['arch-A']}})
 assert.equal(counts(archA),0)
 assert.equal(counts(archB),4)
 assert.equal(pidAlive(pidArch),true);ok('archiving one session leaves shared server running for other session')
 ctx.emit('domain/changed',{domain:'workspace',table:'',operation:'put',value:{archivedSessionIds:['arch-A','arch-B']}})
 assert.equal(counts(archB),0)
 await sleep(50)
 assert.equal(pidAlive(pidArch),false);ok('archiving all referencing sessions immediately releases server process')
 const turnA=agent('turn-A'), turnB=agent('turn-B')
 await direct('mcp_load',{server:'demo'},turnA)
 await direct('mcp_load',{server:'demo'},turnB)
 const pidTurn=JSON.parse(await direct('mcp__demo__identity',{},turnA)).pid
 assert.equal(pidAlive(pidTurn),true)
 endTurn(turnA);assert.equal(counts(turnA),4);ok('the turn containing an MCP call is not an unused turn')
 endTurn(turnA,19)
 assert.equal(counts(turnA),4);ok('19 inactive turns do not revoke tools under 20-turn threshold')
 ctx.emit('session/event',turnA.session,{type:'turn/end',data:{turn:turns.get(turnA)}})
 assert.equal(counts(turnA),4);ok('duplicate turn-end event does not advance inactivity')
 endTurn(turnA)
 assert.equal(counts(turnA),0);ok('20th inactive turn revokes session tools')
 assert.equal(counts(turnB),4)
 assert.equal(pidAlive(pidTurn),true);ok('server process remains alive while second session is below turn threshold')
 await direct('mcp__demo__identity',{},turnB)
 endTurn(turnB)
 endTurn(turnB,19)
 assert.equal(counts(turnB),4)
 endTurn(turnB)
 assert.equal(counts(turnB),0)
 await sleep(50)
 assert.equal(pidAlive(pidTurn),false);ok('server process released once all referencing sessions reach inactive turn threshold')
 await direct('mcp_load',{server:'demo'})
 assert.equal(counts(a),4)
 ctx.emit('agent/disposed',{agent:a});assert.equal(counts(a),0);ok('agent disposal revokes tools')
 await direct('mcp_load',{server:'demo'},b)
 const activeScan=direct('mcp_refresh',{server:'delayed'},b).then(()=>null,e=>e)
 await sleep(25);ctx.emit('dispose');assert.ok(await activeScan);assert.equal(counts(b),0);ok('plugin unload revokes tools and active scans')
 const actualCtx=new Context();new SystemPrompt(actualCtx,{});new Tools(actualCtx);new Agents(actualCtx)
 const actualAgent={id:'actual-fiber-agent',session:{id:'actual-fiber-agent'},status:'idle'},actualScope=createScope(actualCtx,actualAgent);actualAgent.ctx=actualScope.ctx
 const detach=actualCtx.agents.enter(actualAgent,undefined)
 const actualPlugin={inject:['tools','agents','systemPrompt'],apply:pluginCtx=>apply(pluginCtx,{cacheFile:join(temp,'fiber.json'),servers:[{serverName:'generic',command:process.execPath,args:[fakePath]}]})}
 const fiber=await actualCtx.plugin(actualPlugin)
 try {
  await actualCtx.tools.get('mcp_load').execute({server:'generic'},{agent:actualAgent,signal})
  assert.equal(actualCtx.tools.schemas(actualAgent).filter(t=>t.name.startsWith('mcp__')).length,4)
  await fiber.dispose()
  assert.equal(actualCtx.tools.schemas(actualAgent).filter(t=>t.name.startsWith('mcp__')).length,0)
  ok('real Cordis fiber disposal revokes foreign agent-owned registrations')
 } finally {await fiber.dispose();detach();await actualScope.dispose()}
 console.log(JSON.stringify({passed:passes.length,currentGlobalNativeSchemas:counts()}))
} finally {
 ctx.emit('dispose')
 for(const scope of scopes)await scope.dispose()
 const { realpath, rm } = await import('node:fs/promises')
 const { dirname } = await import('node:path')
 const resolved = await realpath(temp)
 assert.equal(dirname(resolved), await realpath(tmpdir()))
 await rm(resolved, { recursive: true, force: true })
}
