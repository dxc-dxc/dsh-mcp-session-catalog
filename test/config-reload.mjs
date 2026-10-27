import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { apply } from '../index.mjs'
const base=process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the @deepseek-ai directory in the target DSH installation')
const dshImport=path=>pathToFileURL(join(base,path)).href
const {Context}=await import(dshImport('cordis/lib/index.js'))
const {default:Tools}=await import(dshImport('dsh-tools/lib/index.js'))
const {default:SystemPrompt}=await import(dshImport('dsh-system-prompt/lib/index.js'))
const {createScope}=await import(dshImport('dsh-scope/lib/index.js'))
const temp=await mkdtemp(join(tmpdir(),'mcp-config-reload-'))
const serversFile=join(temp,'servers.json')
const fake=fileURLToPath(new URL('./fake-server.mjs',import.meta.url))
const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx)
const agent={id:'reload-agent',session:{id:'reload-agent'},status:'idle'}
const scope=createScope(ctx,agent);agent.ctx=scope.ctx
const signal=new AbortController().signal
const run=(name,args={})=>ctx.tools.get(name,agent).execute(args,{agent,signal})
const identity=async()=>JSON.parse(await run('mcp__demo__identity'))
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const mgmt=()=>['mcp_catalog','mcp_load','mcp_refresh'].filter(name=>ctx.tools.get(name,agent))
const server=(name,extra={})=>({serverName:name,purpose:`${name} purpose`,command:process.execPath,args:[fake],...extra})
const writeServers=async list=>{await sleep(12);await writeFile(serversFile,JSON.stringify({servers:list}))}
let passed=0
const ok=message=>{passed++;console.log('PASS',message)}
await writeServers([server('demo'),server('demo2')])
apply(ctx,{serversFile,cacheFile:join(temp,'cache.json'),inactiveTurnsThreshold:20})
try {
 assert.deepEqual(mgmt(),['mcp_catalog','mcp_load','mcp_refresh'])
 const catalog=await run('mcp_catalog')
 assert.match(catalog,/demo purpose/);assert.match(catalog,/demo2 purpose/)
 await run('mcp_load',{server:'demo'})
 const first=await identity()
 assert.equal(alive(first.pid),true)
 ok('entry tools are registered from serversFile')

 await writeServers([server('demo',{env:{RELOADED:'1'}})])
 const afterRemove=await run('mcp_catalog')
 assert.match(afterRemove,/demo purpose/)
 assert.doesNotMatch(afterRemove,/demo2/)
 assert.deepEqual(mgmt(),['mcp_catalog','mcp_load','mcp_refresh'])
 ok('catalog re-reads the file and drops a removed server without disabling the plugin')

 assert.equal(ctx.tools.get('mcp__demo__identity',agent),undefined)
 await assert.rejects(run('mcp_load',{server:'demo2'}),/Unknown MCP server/)
 ok('changed server retires the old scope and the removed name stops resolving')

 await sleep(120);assert.equal(alive(first.pid),false)
 await run('mcp_load',{server:'demo'})
 const second=await identity()
 assert.notEqual(second.pid,first.pid);assert.equal(alive(second.pid),true)
 ok('next explicit load starts a process from the new definition')

 await sleep(12)
 await writeFile(serversFile,'{"servers": [ {"serverName": "demo", ')
 const broken=await run('mcp_catalog')
 assert.match(broken,/previous configuration kept/)
 assert.match(broken,/demo purpose/)
 assert.deepEqual(mgmt(),['mcp_catalog','mcp_load','mcp_refresh'])
 ok('an invalid file reports a warning while the previous configuration keeps working')

 await writeServers([server('demo',{env:{RELOADED:'1'}})])
 const repaired=await run('mcp_catalog')
 assert.doesNotMatch(repaired,/previous configuration kept/)
 assert.match(repaired,/demo purpose/)
 console.log(JSON.stringify({passed}))
} finally {
 ctx.emit('dispose')
 await scope.dispose()
 const resolved=await realpath(temp)
 assert.equal(dirname(resolved),await realpath(tmpdir()))
 assert.ok(basename(resolved).startsWith('mcp-config-reload-'))
 await rm(resolved,{recursive:true,force:true})
}
