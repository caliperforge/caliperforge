import { join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gate } from '../../providers/claude-agent-sdk/index.ts'
import type { Provider } from '../../providers/kind.ts'
import { fire, packet, refuse } from '../index.ts'
import { load, rules, seat } from '../rules.ts'

const root = join(import.meta.dirname, '../..')
const cwd = '/tmp/cf-seat'

const stub: Provider = {
  name: 'claude-agent-sdk',
  fire: (p) => Promise.resolve({ text: p.prompt, usage: { input: 11, cache: 22, output: 33 }, seconds: 1.5, exit: 0 }),
}

test('a write inside write_paths is allowed and one outside is refused with an origin', () => {
  expect(refuse(cwd, ['src'], 'src/hello.ts')).toBeNull()
  expect(refuse(cwd, ['src'], `${cwd}/src/nested/hello.ts`)).toBeNull()
  expect(refuse(cwd, ['src'], 'package.json')).toMatchObject({ origin_kind: 'ruling', origin_ref: 'seat.write_paths' })
  expect(refuse(cwd, ['src'], '../escape.ts')).toMatchObject({ path: '../escape.ts' })
  expect(refuse(cwd, ['src'], 'srcery/hello.ts')).not.toBeNull()
})

test('the provider gate denies a refused write and lets everything else through', () => {
  const p = packet(seat(root, 'typescript_specialist').manifest, 'prompt', 'tight', 'issue', cwd)
  const pre = (tool: string, file: string): HookInput =>
    ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })
  expect(gate(p, pre('Write', 'src/hello.ts'))).toEqual({ continue: true })
  expect(gate(p, pre('Read', '/etc/passwd'))).toEqual({ continue: true })
  expect(gate(p, pre('Write', 'package.json'))).toMatchObject({
    continue: false,
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'ruling:seat.write_paths refuses a write to package.json' },
  })
})

test('the packet carries the Tight spec, the seat prompt and the issue', () => {
  const p = packet(seat(root, 'typescript_specialist').manifest, 'SEAT', 'TIGHT', 'ISSUE', cwd)
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

test('seat() refuses a seat whose prompt drifted from its roster digest', () => {
  expect(() => seat(root, 'nobody')).toThrow(/absent from rules\/roster.yaml/)
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
