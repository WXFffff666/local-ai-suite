// mcp-fixture-server.mjs — 30-line raw JSON-RPC-over-stdio MCP server for
// todo40's real-spawn pool test (newline-delimited framing per the MCP stdio
// transport spec; ZERO dependencies, node built-ins only). Speaks exactly:
// initialize (echoes the client's protocolVersion) / initialized (noop) /
// tools/list (one page) / tools/call ('crash' exits(7) AFTER flushing nothing,
// forcing the client to observe a transport close mid-session).
import * as readline from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const result = (id, res) => send({ jsonrpc: '2.0', id, result: res })

const TOOLS = [
  { name: 'echo', description: 'Echo the message back', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  { name: 'loose', description: 'Schema-less grab bag', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] } },
  { name: 'crash', description: 'Exits the process with code 7', inputSchema: { type: 'object' } },
]

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notifications need no response
  if (msg.method === 'initialize') {
    result(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'las-fixture', version: '0.0.1' },
    })
  } else if (msg.method === 'tools/list') {
    result(msg.id, { tools: TOOLS })
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'crash') { process.exit(7) }
    result(msg.id, { content: [{ type: 'text', text: `${msg.params.name}:${JSON.stringify(msg.params.arguments ?? {})}` }] })
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
