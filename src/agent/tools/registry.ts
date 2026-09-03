/**
 * ToolRegistry — the todo23 plumbing layer between the agent loop and the
 * concrete tools. INTERFACES ONLY: read/write/edit/glob land in todo27, the
 * jailed shell in todo28; both register() here and the loop consumes the
 * registry through the ToolExecutor seam (todo29 wires AgentSessions to it).
 *
 * Permission gating is deliberately NOT here either: todo27/28 execute()
 * bodies call PermissionEngine.evaluate() first (src/agent/policy) and report
 * the awaiting-permission → running transition through ctx.reportPhase.
 *
 * Registration enforces the OpenAI strict-mode contract the R7 anchor pins:
 * parameters must be an object schema with additionalProperties:false and
 * every property required — produce it with zod v4 `z.strictObject({...})`
 * (all fields required) + `z.toJSONSchema(schema)`.
 */

import type { JsonObject, JsonSchema, JsonValue, ToolDef, ToolExecutor, ToolExecutionContext } from '../runner/types'

export type ToolRegistration = {
  readonly def: ToolDef
  /** Receives schema-validated arguments; rejection becomes TOOL_ERROR upstream. */
  readonly run: (args: JsonObject, ctx: ToolExecutionContext) => Promise<unknown>
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** OpenAI strict-function requirements on a JSON Schema (see header). */
export function assertStrictToolSchema(name: string, parameters: JsonSchema): void {
  if (parameters['type'] !== 'object') {
    throw new Error(`tool ${name}: parameters must be an object schema (z.strictObject at the boundary)`)
  }
  if (parameters['additionalProperties'] !== false) {
    throw new Error(`tool ${name}: parameters.additionalProperties must be false (OpenAI strict mode)`)
  }
  const props = isJsonObject(parameters['properties']) ? Object.keys(parameters['properties']) : []
  const required = parameters['required']
  if (props.length === 0) {
    // Zero-property schemas are strict-compatible iff nothing is required.
    if (Array.isArray(required) && required.length > 0) {
      throw new Error(`tool ${name}: required lists properties the schema does not declare`)
    }
    return
  }
  if (!Array.isArray(required)) {
    throw new Error(`tool ${name}: every declared property must be required (OpenAI strict mode)`)
  }
  const requiredNames = new Set(required.filter((r): r is string => typeof r === 'string'))
  for (const prop of props) {
    if (!requiredNames.has(prop)) {
      throw new Error(`tool ${name}: optional property '${prop}' violates strict mode (all properties must be required)`)
    }
  }
}

/** Re-parses the loop-supplied args string — the registry's own trust boundary. */
function parseArgs(argsJson: string): JsonObject {
  let value: JsonValue
  try {
    value = JSON.parse(argsJson) as JsonValue
  } catch {
    throw new Error('invalid tool arguments JSON')
  }
  if (!isJsonObject(value)) {
    throw new Error('tool arguments must be a JSON object')
  }
  return value
}

export class ToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, ToolRegistration>()

  /** Duplicate names throw — the wire cannot advertise a tool twice. */
  register(tool: ToolRegistration): void {
    assertStrictToolSchema(tool.def.name, tool.def.parameters)
    if (this.tools.has(tool.def.name)) {
      throw new Error(`tool ${tool.def.name} is already registered`)
    }
    this.tools.set(tool.def.name, tool)
  }

  list(): readonly ToolDef[] {
    return [...this.tools.values()].map((t) => t.def)
  }

  /**
   * ToolExecutor seam. argsJson arrives from the loop already repaired/parsed,
   * but this is the trust boundary for the executor's own consumers, so it
   * re-parses rather than trusting the string.
   */
  async execute(name: string, argsJson: string, ctx: ToolExecutionContext): Promise<unknown> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      throw new Error(`unknown tool '${name}'`)
    }
    const args = parseArgs(argsJson)
    return tool.run(args, ctx)
  }
}
