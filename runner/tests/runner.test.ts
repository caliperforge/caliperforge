import { appendFileSync, cpSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { fired, gate } from '../../providers/claude-agent-sdk/index.ts'
import type { Provider } from '../../providers/kind.ts'
import { fire, packet, planRow, refuse } from '../index.ts'
import { load, rules, seat } from '../rules.ts'

const root = join(import.meta.dirname, '../..')
const cwd = '/tmp/cf-seat'
const TRANSCRIPT = '/tmp/cf-seat/run.transcript.jsonl'

const stub: Provider = {
  name: 'claude-agent-sdk',
  fire: (p) => Promise.resolve({
    text: p.prompt, transcript_path: p.transcript, usage: { input: 11, cache: 22, output: 33 }, seconds: 1.5, exit: 0, stop_reason: 'end_turn', denials: 0,
  }),
}

function result(over: Record<string, unknown>): SDKResultMessage {
  const base = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [] }
  return { ...base, ...over } as unknown as SDKResultMessage
}

test('a write inside write_paths is allowed and one outside is refused with an origin', () => {
  expect(refuse(cwd, ['src'], 'src/hello.ts')).toBeNull()
  expect(refuse(cwd, ['src'], `${cwd}/src/nested/hello.ts`)).toBeNull()
  expect(refuse(cwd, ['src'], 'package.json')).toMatchObject({ origin_kind: 'ruling', origin_ref: 'seat.write_paths' })
  expect(refuse(cwd, ['src'], '../escape.ts')).toMatchObject({ path: '../escape.ts' })
  expect(refuse(cwd, ['src'], 'srcery/hello.ts')).not.toBeNull()
})

test('a seat building our own kernel writes anywhere but .cf/, and a stranger\'s repo keeps write_paths', () => {
  expect(refuse(cwd, ['src'], 'cli/gh.ts')).toMatchObject({ origin_ref: 'seat.write_paths', path: 'cli/gh.ts' })
  expect(refuse(cwd, ['src'], 'cli/gh.ts', true)).toBeNull()
  expect(refuse(cwd, ['src'], 'src/hello.ts', true)).toBeNull()
  expect(refuse(cwd, ['src'], '.cf/work/2/plan.json', true)).toMatchObject({ origin_ref: 'seat.write_paths', path: '.cf/work/2/plan.json' })
  expect(refuse(cwd, ['src'], '../escape.ts', true)).toMatchObject({ path: '../escape.ts' })

  const manifest = seat(root, 'typescript_specialist').manifest
  expect(packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT, true).refuse('cli/x.ts')).toBeNull()
  expect(packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT).refuse('cli/x.ts')).not.toBeNull()
})

test('the provider gate denies a refused write and lets everything else through', () => {
  const p = packet(seat(root, 'typescript_specialist').manifest, 'prompt', 'tight', 'issue', cwd, TRANSCRIPT)
  const pre = (tool: string, file: string): HookInput =>
    ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })
  expect(gate(p, pre('Write', 'src/hello.ts'))).toEqual({ continue: true })
  expect(gate(p, pre('Read', '/etc/passwd'))).toEqual({ continue: true })
  expect(gate(p, pre('Write', 'package.json'))).toMatchObject({
    continue: false,
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'ruling:seat.write_paths refuses a write to package.json' },
  })
})

const bash = (command: string): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })

test('the builder runs its checks on our tree and holds no shell on a stranger\'s', () => {
  const manifest = seat(root, 'typescript_specialist').manifest
  const ours = packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT, true)
  const theirs = packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT)
  expect(ours.tools).toContain('Bash(npm run tight)')
  expect(theirs.tools.some((t) => t.startsWith('Bash('))).toBe(false)
  expect(gate(ours, bash('npm run test -- store/refusals.test.ts'))).toEqual({ continue: true })
  expect(gate(ours, bash('npm run lint -- --fix'))).toEqual({ continue: true })
  expect(gate(ours, bash('npm install left-pad'))).toMatchObject({ continue: false })
  expect(gate(ours, bash('npm run tight && rm -rf .'))).toMatchObject({ continue: false })
})

test('the kotlin seat keeps gradle on a stranger\'s tree', () => {
  const p = packet(seat(root, 'kotlin_specialist').manifest, 'p', 't', 'i', cwd, TRANSCRIPT)
  expect(p.tools).toContain('Bash(gradle:*)')
})

test('a fence handed in replaces the manifest\'s on a stranger\'s tree', () => {
  const manifest = seat(root, 'outside_specialist').manifest
  const p = packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT, false, ['ruby/lib/config.rb'])
  expect(p.refuse('ruby/lib/config.rb')).toBeNull()
  expect(p.refuse('lua/config.lua')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('the packet carries the Tight spec, the seat prompt and the issue', () => {
  const p = packet(seat(root, 'typescript_specialist').manifest, 'SEAT', 'TIGHT', 'ISSUE', cwd, TRANSCRIPT)
  expect(p.prompt.indexOf('TIGHT')).toBeLessThan(p.prompt.indexOf('SEAT'))
  expect(p.prompt.indexOf('SEAT')).toBeLessThan(p.prompt.indexOf('ISSUE'))
  expect(p.model).toBe('claude-opus-5')
})

test('the rules loader hashes roster, rails and Tight into rules', () => {
  const db = fresh(join(root, 'schema'))
  const loaded = load(db, root)
  expect(loaded.map((r) => r.id)).toContain('typescript_specialist')
  expect(new Set(rules(root).map((r) => r.path))).toEqual(new Set(['rules/rails.yaml', 'rules/roster.yaml', 'rules/tight.md']))
  expect(db.prepare('SELECT count(*) AS n FROM rules').get()).toEqual({ n: loaded.length })
})

test('seat() refuses a seat absent from the roster and one whose prompt drifted from its digest', () => {
  expect(() => seat(root, 'nobody')).toThrow(/absent from rules\/roster.yaml/)
  const drifted = mkdtempSync(join(tmpdir(), 'cf-drift-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(drifted, dir), { recursive: true })
  appendFileSync(join(drifted, 'seats/typescript_specialist/prompt.md'), '\n')
  expect(() => seat(drifted, 'typescript_specialist')).toThrow(/prompt does not match its digest/)
})

test('a write under a symlinked cwd resolves to the same root and is allowed', () => {
  const target = mkdtempSync(join(tmpdir(), 'cf-real-'))
  const link = join(mkdtempSync(join(tmpdir(), 'cf-link-')), 'seat')
  symlinkSync(target, link)
  expect(refuse(link, ['src'], join(realpathSync(target), 'src/hello.ts'))).toBeNull()
  expect(refuse(link, ['src'], join(realpathSync(target), 'package.json'))).toMatchObject({ path: 'package.json' })
})

test('a hook-stopped session lands non-zero carrying the refusal origin, a completed one lands zero', () => {
  const reason = 'ruling:seat.write_paths refuses a write to package.json'
  const stopped = fired(result({ result: '', terminal_reason: 'hook_stopped' }), Date.now(), [reason])
  expect(stopped).toMatchObject({ exit: 1, denials: 1, stop_reason: reason, text: reason })
  const clean = fired(result({ result: 'done', terminal_reason: 'completed' }), Date.now(), [])
  expect(clean).toMatchObject({ exit: 0, denials: 0, stop_reason: 'end_turn', text: 'done' })
})

test('the runs rule_hash check refuses 64 characters that are not all hex', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = String(planRow(db))
  const insert = (hash: string): string =>
    `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
     VALUES (${plan}, 2, 'typescript_specialist', '${hash}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`
  expect(rejects(db, insert(`0${'z'.repeat(63)}`))).toBe(true)
  expect(rejects(db, insert('a'.repeat(64)))).toBe(false)
})

test('firing one step writes one runs row carrying the rule hash as sent', async () => {
  const db = fresh(join(root, 'schema'))
  const { id } = await fire(db, root, 'typescript_specialist', cwd, 'ISSUE', stub)
  const row = db.prepare('SELECT step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit FROM runs WHERE id = ?').get(id)
  expect(row).toEqual({
    step: 2, seat: 'typescript_specialist', rule_hash: seat(root, 'typescript_specialist').hash,
    provider: 'claude-agent-sdk', model: 'claude-opus-5', effort: 'high',
    input_tokens: 11, cache_tokens: 22, output_tokens: 33, seconds: 1.5, exit: 0,
  })
})
