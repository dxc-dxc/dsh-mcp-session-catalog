import { harness, apply } from './hub-harness.mjs'
let host, agent
process.on('message', async message => {
  const { id, op, args = {} } = message
  try {
    let result
    if (op === 'init') { host = harness({ traceFile: args.traceFile, hostName: args.hostName }); agent = await host.agent(args.hostName); apply(host.ctx, args.config); result = true }
    else if (op === 'run') result = await host.run(agent, args.name, args.arguments)
    else if (op === 'schemas') result = host.schemas(agent)
    else if (op === 'close') { await host.close(); result = true }
    else throw new Error(`Unknown test host operation ${op}`)
    process.send?.({ id, result })
    if (op === 'close') process.disconnect()
  } catch (error) { process.send?.({ id, error: { message: error.message, stack: error.stack } }) }
})
