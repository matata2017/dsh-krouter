import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { KROUTER_TOOL_NAMES, registerKrouterTools } from '../extras/dsh/lib/register.js'
import { TurnRecorder, clearKey, keyStatus, setKey } from '../extras/dsh/lib/memory.js'

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

test('KRouter key file set/status/clear never echoes the value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krouter-keys-'))
  const previous = process.env.KROUTER_KEYS_ENV
  process.env.KROUTER_KEYS_ENV = join(dir, 'keys.env')
  try {
    assert.deepEqual(keyStatus().present, [])
    assert.deepEqual(setKey('DEEPSEEK_API_KEY', 'sk-test-value-123').present, ['DEEPSEEK_API_KEY'])
    assert.deepEqual(keyStatus().present, ['DEEPSEEK_API_KEY'])
    assert.deepEqual(clearKey('DEEPSEEK_API_KEY').present, [])
    assert.throws(() => setKey('NOT_A_PROVIDER', 'sk-test'), /unsupported key name/)
    assert.throws(() => setKey('DEEPSEEK_API_KEY', 'YOUR_DEEPSEEK_API_KEY'), /placeholder/)
  } finally {
    if (previous === undefined) delete process.env.KROUTER_KEYS_ENV
    else process.env.KROUTER_KEYS_ENV = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('KRouter turn recorder writes one excerpt page per session and day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krouter-excerpt-'))
  try {
    const recorder = new TurnRecorder(dir, {}, () => {})
    recorder.noteUser('session-abcd1234', 'how do I do X?')
    recorder.noteAssistant('session-abcd1234', 'do Y then Z')
    const file = recorder.flush('session-abcd1234')
    assert.ok(file, 'flush should return the written page')
    assert.equal(recorder.flush('session-abcd1234'), null, 'a second flush without new turns writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('KRouter excerpt records the project, matching Claude Code per-project memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krouter-project-'))
  try {
    const recorder = new TurnRecorder(dir, {}, () => {})
    recorder.noteUser('session-abcd1234', 'question', 'D:\\advisor')
    recorder.noteAssistant('session-abcd1234', 'answer')
    const file = recorder.flush('session-abcd1234')
    const head = readFileSync(file, 'utf8').split('---')[1]
    assert.match(head, /^project: advisor$/m, 'project name is recorded')
    assert.match(head, /^project_root: D:\/advisor$/m, 'project root is recorded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
