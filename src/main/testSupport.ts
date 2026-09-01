/**
 * Test-support hooks for the real-app E2E (plan todo12). Production runtime
 * never sets these variables; behavior is byte-identical when absent.
 *
 * LAS_E2E_API_PORT — relocation seam for the 11434 arbitration/dial port,
 * needed ONLY on hosts where 127.0.0.1:11434..11529 is a WinNAT/Hyper-V
 * excluded port range (a non-admin process cannot bind there at all — EACCES —
 * which would make the todo10 embedded bind and the todo12 stub-server smoke
 * unrunnable on that machine). The FIXED public promise of 11434 remains the
 * default everywhere else, including every packaged app and CI run.
 *
 * The override flows through the SAME values the production code uses:
 *  - src/main/apiServer.ts startApiServer probes/binds this port,
 *  - the resulting ApiServerStatus.port travels via getEngineOwnership
 *    (src/main/index.ts) into ChatRelay.resolveUpstream, so the
 *    external-takeover dial hits the same coordinates the probe validated.
 * Nothing else about arbitration, guards, or relay semantics changes.
 */

function readPortEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port (got ${JSON.stringify(raw)})`)
  }
  return port
}

/** Overridden 11434 port for the local OpenAI-compat promise, or undefined. */
export const E2E_API_PORT: number | undefined = readPortEnv('LAS_E2E_API_PORT')
