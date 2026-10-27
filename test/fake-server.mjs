import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
if(process.env.START_MARKER)appendFileSync(process.env.START_MARKER,String(process.pid)+'\n')
let reads = 0, writes = 0, initializes = 0, lists = 0
if(process.env.IGNORE_TERM){process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
const tools = [
 {name:'identity',description:'Identify this connection',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}},
 {name:'slow',description:'Wait for a requested duration',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{ms:{type:'number'}}}},
 {name:'flaky_read',description:'Fail twice then succeed',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}},
 {name:'flaky_write',description:'Fail a state-changing operation',annotations:{readOnlyHint:false},inputSchema:{type:'object',properties:{}}},
]
const send = (id,result,error) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n')
for await (const line of createInterface({input:process.stdin})) {
 let m; try {m=JSON.parse(line)} catch {continue}
 if (m.id === undefined) continue
 void (async()=>{
 if(m.method==='initialize') {initializes++;if(process.env.START_DELAY_MS)await new Promise(r=>setTimeout(r,+process.env.START_DELAY_MS));if(typeof m.params?.protocolVersion!=='string')return send(m.id,null,{code:-32602,message:'protocolVersion required'});return send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'regression',version:'1'}})}
 if(m.method==='tools/list'){lists++;process.stdout.write('null\n[]\n');return send(m.id,{tools})}
 if(m.method==='tools/call') {
  const {name,arguments:args}=m.params
  if(name==='slow' && args.ms===-1)return send(m.id,{content:[{type:'resource',resource:{uri:'test://embedded',mimeType:'text/plain',text:'embedded file content'}}]})
  if(name==='slow')await new Promise(r=>setTimeout(r,args.ms??100))
  if(name==='flaky_read' && ++reads<3)return send(m.id,null,{code:-32603,message:'fetch failed: ECONNRESET'})
  if(name==='flaky_write')return send(m.id,null,{code:-32603,message:`fetch failed: ECONNRESET write_attempt=${++writes}`})
  return send(m.id,{content:[{type:'text',text:JSON.stringify({pid:process.pid,reads,writes,initializes,lists})}]})
 }
 send(m.id,null,{code:-32601,message:'unsupported'})
 })()
}
