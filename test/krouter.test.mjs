import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { KROUTER_TOOL_NAMES, registerKrouterTools } from '../extras/dsh/lib/register.js'

const VAULT = 'D:/krouter-dsh/vault'
const ROUTER = 'D:/krouter-dsh/skill/krouter/scripts/route_knowledge.py'
const MCP = 'D:/krouter-dsh/skill/krouter/scripts/mcp_server.py'

test('KRouter native DSH tools are registered and search the template vault', async () => {
  const registered = []
  registerKrouterTools(
    { tools: { register(tool) { registered.push(tool) } } },
    { vaultPath: VAULT, routerScript: ROUTER },
    spec => spec,
  )
  assert.deepEqual(registered.map(tool => tool.name), KROUTER_TOOL_NAMES)
  const search = registered.find(tool => tool.name === 'krouter_search')
  const result = await search.execute({ query: 'home' })
  assert.equal(result.ok, true)
  assert.equal(result.canonical_match, 'true')
  assert.equal(result.canonical_id, 'Q01')
  assert.match(result.text, /Agent第二大脑\.md/)
})

test('KRouter MCP server exposes five tools', async () => {
  const child = spawn('python', [MCP, '--vault', VAULT], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('KRouter MCP tools/list timed out')), 10000)
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.id === 2) { clearTimeout(timer); resolve(message) }
      }
    })
    child.on('error', reject)
  })
  const request = (method, params, id) => `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
  child.stdin.write(request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 1))
  await new Promise(resolve => setTimeout(resolve, 100))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(request('tools/list', {}, 2))
  const message = await response
  child.kill()
  assert.deepEqual(message.result.tools.map(tool => tool.name).sort(), [
    'krouter_ask',
    'krouter_correct',
    'krouter_learn',
    'krouter_note',
    'krouter_status',
  ])
})
