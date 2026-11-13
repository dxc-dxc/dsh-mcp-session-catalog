import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'skill-loader'
export const inject = ['tools', 'skills', 'workingDirectory']

let resolvedWithoutInstallAnchor = false

async function officialModule(specifier) {
  // Match the running Host's official helpers. Workspace ancestors may carry
  // older DSH packages, so never let them shadow an explicit runtime anchor.
  const anchor = process.env.DSH_INSTALL_DIR
    ? join(process.env.DSH_INSTALL_DIR, 'package.json') : import.meta.url
  if (!process.env.DSH_INSTALL_DIR) resolvedWithoutInstallAnchor = true
  const resolved = createRequire(anchor).resolve(specifier)
  return import(pathToFileURL(resolved).href)
}

// Tests may supply the real helpers from their selected DSH runtime, without
// requiring this workspace to install a second copy of Harness.
export function createSkillLoader({ defineTool, isSkillName, renderSkillContent }) {
  return {
    name,
    inject,
    apply(ctx) {
      ctx.tools.register(defineTool({
        name: 'skill_load',
        description: 'Load a skill by name, including hidden skills matched by skill-router.',
        parameters: {
          name: { type: 'string', required: true, description: 'The exact skill name.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              provider: { type: 'string', required: true },
              resourceBase: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, const: 'directory' },
                      path: { type: 'string', required: true },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, const: 'url' },
                      url: { type: 'string', required: true },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, const: 'opaque' },
                      description: { type: 'string', required: true },
                    },
                  },
                ],
              },
              content: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
        },
        async execute(args, exec) {
          if (!exec.agent) throw new Error('skill_load requires a calling agent')
          if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`)
          const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
          const lookup = { cwd, scope: exec.agent, signal: exec.signal }
          const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
          assertAvailable(summary, args.name)
          const skill = await ctx.skills.get(args.name, lookup)
          assertAvailable(skill, args.name)
          return {
            name: skill.name,
            provider: skill.provider,
            ...skill.resourceBase !== undefined ? { resourceBase: { ...skill.resourceBase } } : {},
            content: skill.content,
          }
        },
        presentCall(args) {
          return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
        },
      }))
    },
  }
}

function assertAvailable(skill, skillName) {
  if (!skill) throw new Error(`skill "${skillName}" is unknown or no longer available`)
  if (skill.invocation.modelInvocable === false && skill.invocation.userInvocable === false) {
    throw new Error(`skill "${skillName}" is disabled for both model and user invocation`)
  }
}

// This entry only activates where the installed Harness exposes the official
// skill renderer and tool factory it reuses. Elsewhere it stays inert so the
// MCP half of the bundle keeps working on the older supported versions.
const requiredHelpers = helpers => ['defineTool', 'isSkillName', 'renderSkillContent']
  .filter(key => typeof helpers[key] !== 'function')

export async function apply(ctx) {
  let skills, tools
  try {
    [skills, tools] = await Promise.all([
      officialModule('@deepseek-ai/dsh-skill'),
      officialModule('@deepseek-ai/dsh-tools'),
    ])
  } catch (error) {
    ctx.logger?.warn?.(`skill_load is unavailable: official skill modules could not be imported (${error?.code ?? error?.message ?? error})`)
    return
  }
  const helpers = { ...skills, defineTool: tools.defineTool }
  const missing = requiredHelpers(helpers)
  if (missing.length > 0) {
    ctx.logger?.warn?.(`skill_load is unavailable: the installed Harness does not export ${missing.join(', ')}`)
    return
  }
  ctx.fiber.assertActive()
  if (resolvedWithoutInstallAnchor) {
    // Not fatal, but this is how a stale vendored copy could get picked up;
    // say so once instead of silently rendering with a different version.
    ctx.logger?.warn?.('skill_load resolved official skill modules without DSH_INSTALL_DIR; a vendored copy may take precedence over the running Host')
  }
  createSkillLoader(helpers).apply(ctx)
}
