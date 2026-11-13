// Test fixtures use the actual selected DSH runtime's public execution API.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = process.env.DSH_TEST_MODULE_ROOT
if (!base) throw new Error('Set DSH_TEST_MODULE_ROOT to the target DSH @deepseek-ai directory')
const load = name => import(pathToFileURL(join(base, `${name}/lib/index.js`)).href)
const { default: Tools } = await load('dsh-tools')
const native = typeof Tools.prototype.setExecutor === 'function' ? await load('dsh-tool-executor-native') : undefined

export function installNativeExecutor(ctx) { native?.apply(ctx) }
export async function dispatchOne(ctx, { agent, name, arguments: args, signal, callId }) {
  if (!native) return ctx.tools.execute({ agent, name, arguments: args, signal, callId })
  const batch = await ctx.tools.execute({ agent, signal, calls: [{ id: callId, name, arguments: JSON.stringify(args) }] })
  return batch.results[0].result
}
