import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
    'krouter_skill',
    'krouter_status',
  ])
})

test('KRouter learn() writes a card with a modified timestamp', () => {
  // Goes through learn(), not write_card(), so the whole write path is exercised
  // (the earlier version called write_card directly and would not catch a missing
  // datetime import on the caller's side).
  const script = `
import sys, tempfile, shutil
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import experience
tmp = Path(tempfile.mkdtemp())
try:
    (tmp / '90 系统文件').mkdir(parents=True)
    path, why = experience.learn(tmp, {
        'situation': 'a', 'action': 'b', 'result': 'c',
        'subject': ['probe'],
        'lesson': 'when the same thing happens, do this',
        'title': 'a card'}, 'src')
    assert path is not None, why
    print(path.read_text(encoding='utf-8'))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  assert.match(out, /^modified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/m,
    'card frontmatter carries an ISO 8601 modified timestamp')
})

test('KRouter index warns when topics fall outside the budget', () => {
  const script = `
import sys
sys.path.insert(0, 'skill/krouter/scripts')
import compile_subconscious as cs
from pathlib import Path
cs.standing_index(Path('D:/krouter-dsh/vault'), chars=5)
`
  const result = spawnSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      KROUTER_MAP: 'D:/krouter-dsh/vault/90 系统文件/canonical_sources.psv',
    },
  })
  assert.match(result.stderr, /topic\(s\) beyond the \d+-line/, 'overflow is reported on stderr')
})

test('KRouter checkup lists old provisional cards for review', () => {
  const script = `
import sys, tempfile, shutil
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import checkup
tmp = Path(tempfile.mkdtemp())
try:
    d = tmp / '02 经验与方法' / '经验卡'
    d.mkdir(parents=True)
    (d / 'old.md').write_text('''---
title: "经验｜旧卡"
type: experience-card
status: provisional
date: 2026-01-01
source: krouter-learn
---

- 处境：a
- 做法：b
- 结果：c
- 通用说法：同类情况发生时按这个做
''', encoding='utf-8')
    due = checkup.review_candidates(tmp)
    print(len(due), due[0]['age_days'] > 60 if due else False)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }).trim()
  assert.equal(out, '1 True', 'an old provisional card is offered for review')
})

test('KRouter card lifecycle: candidate stays out of the digest until promoted', () => {
  const script = `
import sys, tempfile, shutil
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import experience
tmp = Path(tempfile.mkdtemp())
try:
    (tmp / '90 系统文件').mkdir(parents=True)
    p, why = experience.learn(tmp, {'situation': 'a', 'action': 'b', 'result': 'c',
        'subject': ['probe'], 'lesson': 'when the same thing happens, do this', 'title': 'a card'}, 'src')
    assert p is not None, why
    head = p.read_text(encoding='utf-8').split('---')[1]
    assert 'status: candidate' in head, 'new cards start as candidate'
    assert 'authority: inferred' in head, 'authority defaults to inferred'
    assert experience.digest(tmp) == '', 'a candidate does not enter the digest'
    cid = experience.load_cards(tmp)[0]['id']
    ok, msg = experience.promote(tmp, cid, 'active')
    assert ok, msg
    assert experience.digest(tmp) != '', 'an active card enters the digest'
    print('ok')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }).trim()
  assert.equal(out, 'ok')
})

test('KRouter keeps legacy provisional cards in the digest', () => {
  // Tightening DIGEST_STATUSES to only "active" would have emptied the digest for
  // every existing card; this pins the backward-compatible behaviour.
  const script = `
import sys
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import experience
d = experience.digest(Path('D:/krouter-dsh/vault'))
cards = experience.load_cards(Path('D:/krouter-dsh/vault'))
provisional = [c for c in cards if c.get('status') == 'provisional']
shown = [c['id'] for c in provisional if c['id'] in d]
print(len(provisional), len(shown))
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }).trim()
  const [total, shown] = out.split(' ').map(Number)
  assert.ok(total > 0, 'the vault has provisional cards')
  assert.equal(shown, total, 'every provisional card is still in the digest')
})

test('KRouter marks a user-stated rule as explicit_user', () => {
  const script = `
import sys, tempfile, shutil
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import experience
tmp = Path(tempfile.mkdtemp())
try:
    (tmp / '90 系统文件').mkdir(parents=True)
    p, why = experience.learn(tmp, {'situation': 'a', 'action': 'b', 'result': 'c',
        'subject': ['probe'], 'lesson': 'when the same thing happens, do this',
        'title': 'a card', 'authority': 'explicit_user'}, 'src')
    assert p is not None, why
    assert 'authority: explicit_user' in p.read_text(encoding='utf-8')
    print('ok')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }).trim()
  assert.equal(out, 'ok')
})

test('KRouter auto-promotes a candidate when a later turn adopts it', () => {
  // Goes through record_uses/uses_in with the real ADOPT regex, so the headline
  // promise ("adopted once → active") is exercised end to end, not just promote().
  const script = `
import sys, tempfile, shutil
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import experience
tmp = Path(tempfile.mkdtemp())
try:
    (tmp / '90 系统文件').mkdir(parents=True)
    p, why = experience.learn(tmp, {'situation': 'a', 'action': 'b', 'result': 'c',
        'subject': ['probe'], 'lesson': 'when the same thing happens, do this', 'title': 'a card'}, 'src')
    assert p is not None, why
    cid = experience.load_cards(tmp)[0]['id']
    assert experience.load_cards(tmp)[0]['status'] == 'candidate'
    # 第一轮回复引用了这张卡；下一句说"管用" —— uses_in 靠这个判据记 adopted
    turns = [
        {'ask': 'what should I do?', 'answer': f'试试这条〔{cid}〕', 'ts': '2026-11-22T10:00:00'},
        {'ask': '管用，问题解决了', 'answer': 'ok', 'ts': '2026-11-22T10:01:00'},
    ]
    n = experience.record_uses(tmp, 'sess-1', turns)
    u = experience.usage(tmp).get(cid, {})
    status = experience.load_cards(tmp)[0]['status']
    print(n, u.get('adopted', 0), status)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }).trim()
  const [events, adopted, status] = out.split(' ')
  assert.ok(Number(events) > 0, 'use events were recorded')
  assert.equal(adopted, '1', 'the adoption was detected by the ADOPT regex')
  assert.equal(status, 'active', 'the candidate was promoted to active')
})

test('KRouter record_adopted promotes directly without a fake turn', () => {
  const script = `
import sys, tempfile, shutil
sys.path.insert(0, 'skill/krouter/scripts')
from pathlib import Path
import experience
tmp = Path(tempfile.mkdtemp())
try:
    (tmp / '90 系统文件').mkdir(parents=True)
    p, why = experience.learn(tmp, {'situation': 'a', 'action': 'b', 'result': 'c',
        'subject': ['probe'], 'lesson': 'when the same thing happens, do this', 'title': 'a card'}, 'src')
    assert p is not None, why
    cid = experience.load_cards(tmp)[0]['id']
    experience.record_adopted(tmp, cid, 'manual')
    u = experience.usage(tmp).get(cid, {})
    print(u.get('adopted', 0), experience.load_cards(tmp)[0]['status'])
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`
  const out = execFileSync('python', ['-c', script], {
    cwd: 'D:/krouter-dsh', encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }).trim()
  assert.equal(out, '1 active', 'a direct adoption records adopted and promotes')
})
