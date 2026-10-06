import { appendFileSync, cpSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { fired, gate } from '../../providers/claude-agent-sdk/index.ts'
import { CAPPED, type Provider } from '../../providers/kind.ts'
import { fire, packet, planRow, refuse } from '../index.ts'
import { load, rules, seat } from '../rules.ts'

const root = join(import.meta.dirname, '../..')
const cwd = '/tmp/cf-seat'
const TRANSCRIPT = '/tmp/cf-seat/run.transcript.jsonl'

const stub: Provider = {
  name: 'claude-agent-sdk',
  fire: (p) => Promise.resolve({
    text: p.prompt, transcript_path: p.transcript, usage: { input: 11, cache: 22, output: 33 }, seconds: 1.5, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0,
  }),
}

function result(over: Record<string, unknown>): SDKResultMessage {
  const base = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [],
    usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }
  return { ...base, ...over } as unknown as SDKResultMessage
}

test('a write outside write_paths is refused with an origin', () => {
  expect(refuse(cwd, ['src'], 'src/hello.ts')).toBeNull()
  expect(refuse(cwd, ['src'], `${cwd}/src/nested/hello.ts`)).toBeNull()
  expect(refuse(cwd, ['src'], 'package.json')).toMatchObject({ origin_kind: 'ruling', origin_ref: 'seat.write_paths' })
  expect(refuse(cwd, ['src'], '../escape.ts')).toMatchObject({ path: '../escape.ts' })
  expect(refuse(cwd, ['src'], 'srcery/hello.ts')).not.toBeNull()
})

test('ours writes all but .cf/; a stranger\'s keeps write_paths', () => {
  expect(refuse(cwd, ['src'], 'cli/gh.ts')).toMatchObject({ origin_ref: 'seat.write_paths', path: 'cli/gh.ts' })
  expect(refuse(cwd, ['src'], 'cli/gh.ts', true)).toBeNull()
  expect(refuse(cwd, ['src'], 'src/hello.ts', true)).toBeNull()
  expect(refuse(cwd, ['src'], '.cf/work/2/plan.json', true)).toMatchObject({ origin_ref: 'seat.write_paths', path: '.cf/work/2/plan.json' })
  expect(refuse(cwd, ['src'], '../escape.ts', true)).toMatchObject({ path: '../escape.ts' })

  const manifest = seat(root, 'typescript_specialist').manifest
  expect(packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT, true).refuse('cli/x.ts')).toBeNull()
  expect(packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT).refuse('cli/x.ts')).not.toBeNull()
})

test('the gate stops a refused write and denies an outside read', () => {
  const p = packet(seat(root, 'typescript_specialist').manifest, 'prompt', 'tight', 'issue', cwd, TRANSCRIPT, false, ['src'])
  const pre = (tool: string, file: string): HookInput =>
    ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })
  expect(gate(p, pre('Write', 'src/hello.ts'))).toEqual({ continue: true })
  expect(gate(p, pre('Read', 'src/hello.ts'))).toEqual({ continue: true })
  expect(gate(p, pre('Read', '/etc/passwd'))).toMatchObject({
    continue: true,
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('run.outside_checkout') as string },
  })
  expect(gate(p, pre('Write', 'package.json'))).toMatchObject({
    continue: false,
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'ruling:seat.write_paths refuses a write to package.json' },
  })
})

const bash = (command: string, background?: boolean): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: background === undefined ? { command } : { command, run_in_background: background }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })

test('the builder holds checks on our tree and no shell on theirs', () => {
  const manifest = seat(root, 'typescript_specialist').manifest
  const ours = packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT, true)
  const theirs = packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT)
  expect(ours.tools).toContain('Bash(npm run tight)')
  expect(theirs.tools.some((t) => t.startsWith('Bash('))).toBe(false)
  expect(gate(ours, bash('npm run test -- store/refusals.test.ts'))).toEqual({ continue: true })
  expect(gate(ours, bash('npm run lint -- --fix'))).toEqual({ continue: true })
  for (const command of ['npm install left-pad', 'npm run tight && rm -rf .', 'grep -rn x src']) {
    expect(gate(ours, bash(command))).toMatchObject({ continue: true, hookSpecificOutput: { permissionDecision: 'deny' } })
  }
})

test('a background run is denied and the seat stays in the session', () => {
  const ours = packet(seat(root, 'typescript_specialist').manifest, 'p', 't', 'i', cwd, TRANSCRIPT, true)
  const denied = gate(ours, bash('npm run tight', true))
  expect(denied).toMatchObject({ continue: true, hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'ruling:seat.tools refuses run_in_background: run it in the foreground and wait for it' } })
  expect(denied.stopReason).toBeUndefined()
  expect(gate(ours, bash('npm run tight', false))).toEqual({ continue: true })
  expect(gate(ours, bash('npm run tight'))).toEqual({ continue: true })
})

test('the kotlin seat keeps gradle on a stranger\'s tree', () => {
  const p = packet(seat(root, 'kotlin_specialist').manifest, 'p', 't', 'i', cwd, TRANSCRIPT)
  expect(p.tools).toContain('Bash(gradle:*)')
})

test('six language seats keep their commands on a stranger\'s tree', () => {
  const held = { rust_specialist: 'Bash(cargo test:*)', python_specialist: 'Bash(uv run:*)', ruby_specialist: 'Bash(bundle exec:*)',
    go_specialist: 'Bash(go test:*)', php_specialist: 'Bash(composer:*)', lua_specialist: 'Bash(just:*)' }
  for (const [name, tool] of Object.entries(held)) {
    expect(packet(seat(root, name).manifest, 'p', 't', 'i', cwd, TRANSCRIPT).tools).toContain(tool)
  }
})

test('a fence handed in replaces the manifest\'s on a stranger\'s', () => {
  const manifest = seat(root, 'outside_specialist').manifest
  const p = packet(manifest, 'p', 't', 'i', cwd, TRANSCRIPT, false, ['ruby/lib/config.rb'])
  expect(p.refuse('ruby/lib/config.rb')).toBeNull()
  expect(p.refuse('lua/config.lua')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('the packet carries Tight, the seat prompt and the issue', () => {
  const p = packet(seat(root, 'typescript_specialist').manifest, 'SEAT', 'TIGHT', 'ISSUE', cwd, TRANSCRIPT)
  expect(p.prompt.indexOf('TIGHT')).toBeLessThan(p.prompt.indexOf('SEAT'))
  expect(p.prompt.indexOf('SEAT')).toBeLessThan(p.prompt.indexOf('ISSUE'))
  expect(p.model).toBe('claude-opus-5-5')
})

test('the rules loader hashes roster, rails and Tight into rules', () => {
  const db = fresh(join(root, 'schema'))
  const loaded = load(db, root)
  expect(loaded.map((r) => r.id)).toContain('typescript_specialist')
  expect(new Set(rules(root).map((r) => r.path))).toEqual(new Set(['rules/rails.yaml', 'rules/roster.yaml', 'rules/tight.md', 'rules/registry.yaml', 'rules/registry/26-dispositions.yaml', 'rules/registry/27-signoffs.yaml', 'rules/registry/28-proposals.yaml', 'rules/registry/29-ratchet_refuse.yaml', 'rules/registry/30-intake.yaml', 'rules/registry/31-stuck_plans.yaml', 'rules/registry/32-science_pull.yaml', 'rules/registry/33-site_publish.yaml', 'rules/registry/34-director_look.yaml', 'rules/registry/35-typescript_specialist.yaml', 'rules/registry/36-daily_learnings.yaml', 'rules/registry/37-review_examples.yaml', 'rules/registry/38-director_fix_reach.yaml', 'rules/registry/39-tick_deps.yaml', 'rules/registry/40-watch.yaml', 'rules/registry/41-director_widen.yaml', 'rules/registry/42-target_parked_once.yaml', 'rules/registry/43-director_ceiling.yaml', 'rules/staffing.yaml']))
  expect(db.prepare('SELECT count(*) AS n FROM rules').get()).toEqual({ n: loaded.length })
})

test('seat() refuses one off the roster or with a drifted prompt', () => {
  expect(() => seat(root, 'nobody')).toThrow(/absent from rules\/roster.yaml/)
  const drifted = mkdtempSync(join(tmpdir(), 'cf-drift-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(drifted, dir), { recursive: true })
  appendFileSync(join(drifted, 'seats/typescript_specialist/prompt.md'), '\n')
  expect(() => seat(drifted, 'typescript_specialist')).toThrow(/prompt does not match its digest/)
})

test('a write under a symlinked cwd resolves to the same root', () => {
  const target = mkdtempSync(join(tmpdir(), 'cf-real-'))
  const link = join(mkdtempSync(join(tmpdir(), 'cf-link-')), 'seat')
  symlinkSync(target, link)
  expect(refuse(link, ['src'], join(realpathSync(target), 'src/hello.ts'))).toBeNull()
  expect(refuse(link, ['src'], join(realpathSync(target), 'package.json'))).toMatchObject({ path: 'package.json' })
})

test('a new file named via a symlink to the checkout is allowed', () => {
  const target = mkdtempSync(join(tmpdir(), 'cf-real-'))
  const link = join(mkdtempSync(join(tmpdir(), 'cf-link-')), 'seat')
  symlinkSync(target, link)
  expect(refuse(realpathSync(target), [], join(link, 'sequencer/publish.ts'), true)).toBeNull()
  expect(refuse(realpathSync(target), [], join(link, '.cf/notes.md'), true)).toMatchObject({ path: '.cf/notes.md' })
})

test('hook-stopped lands non-zero with its origin, completed zero', () => {
  const reason = 'ruling:seat.write_paths refuses a write to package.json'
  const stopped = fired(result({ result: '', terminal_reason: 'hook_stopped' }), Date.now(), [reason])
  expect(stopped).toMatchObject({ ended: 'stopped', exit: 1, denials: 1, stop_reason: reason, text: reason })
  const clean = fired(result({ result: 'done', terminal_reason: 'completed' }), Date.now(), [])
  expect(clean).toMatchObject({ ended: 'completed', exit: 0, denials: 0, stop_reason: 'end_turn', text: 'done' })
})

test('a session that spent its turns lands the cap in stop_reason', () => {
  const capped = fired(result({ subtype: 'error_max_turns', is_error: true, errors: [], terminal_reason: 'max_turns' }), Date.now(), [])
  expect(capped).toMatchObject({ ended: 'stopped', exit: 1, stop_reason: CAPPED })
})

test('a refused command is counted and the session lands zero', () => {
  const denied = { tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'grep -rn x src' } }
  expect(fired(result({ result: 'done', permission_denials: [denied] }), Date.now(), [])).toMatchObject({ exit: 0, denials: 1 })
})

test('runs.rule_hash refuses 64 characters that are not all hex', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = String(planRow(db))
  const insert = (hash: string): string =>
    `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path)
     VALUES (${plan}, 2, 'typescript_specialist', '${hash}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`
  expect(rejects(db, insert(`0${'z'.repeat(63)}`))).toBe(true)
  expect(rejects(db, insert('a'.repeat(64)))).toBe(false)
})

test('one fired step writes one runs row with the rule hash sent', async () => {
  const db = fresh(join(root, 'schema'))
  const { id } = await fire(db, root, 'typescript_specialist', cwd, 'ISSUE', stub)
  const row = db.prepare('SELECT step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, cost_usd FROM runs WHERE id = ?').get(id)
  expect(row).toEqual({
    step: 2, seat: 'typescript_specialist', rule_hash: seat(root, 'typescript_specialist').hash,
    provider: 'claude-agent-sdk', model: 'claude-opus-5-5', effort: 'high',
    input_tokens: 11, cache_read_tokens: 22, output_tokens: 33, seconds: 1.5, exit: 0, cost_usd: null,
  })
})

test('the SDK\'s total_cost_usd lands in the runs row', async () => {
  const db = fresh(join(root, 'schema'))
  const costed = fired(result({ result: 'done', total_cost_usd: 0.42 }), Date.now(), [])
  expect(costed.usage.cost).toBe(0.42)
  const provider: Provider = { name: 'claude-agent-sdk', fire: (p) => Promise.resolve({ ...costed, transcript_path: p.transcript }) }
  const { id } = await fire(db, root, 'typescript_specialist', cwd, 'ISSUE', provider)
  expect(db.prepare('SELECT cost_usd FROM runs WHERE id = ?').get(id)).toEqual({ cost_usd: 0.42 })
})

test('D6 cache writes stay in input_tokens and cache_write_tokens', async () => {
  const db = fresh(join(root, 'schema'))
  const usage = { m: { inputTokens: 10, cacheCreationInputTokens: 4, cacheReadInputTokens: 20, outputTokens: 0 } }
  const split = { cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 } }
  const written = fired(result({ result: 'done', modelUsage: usage, usage: split }), Date.now(), [])
  expect(written.usage).toMatchObject({ input: 14, cache: 20, write: 4, write_1h: 3 })
  const provider: Provider = { name: 'claude-agent-sdk', fire: (p) => Promise.resolve({ ...written, transcript_path: p.transcript }) }
  const { id } = await fire(db, root, 'typescript_specialist', cwd, 'ISSUE', provider)
  expect(db.prepare('SELECT input_tokens, cache_write_tokens, cache_write_1h_tokens, cache_read_tokens FROM runs WHERE id = ?').get(id))
    .toEqual({ input_tokens: 14, cache_write_tokens: 4, cache_write_1h_tokens: 3, cache_read_tokens: 20 })
})
