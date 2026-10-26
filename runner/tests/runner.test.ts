import { appendFileSync, cpSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { fired, gate } from '../../providers/claude-agent-sdk/index.ts'
import { CAPPED, type Packet, type Provider } from '../../providers/kind.ts'
import { rules as ruleRows } from '../../store/index.ts'
import { runOf } from '../../store/runs.ts'
import { fire, packet, planRow, refuse } from '../index.ts'
import { digest, expected, listed, load, registered, rules, Seat, seat } from '../rules.ts'

const root = join(import.meta.dirname, '../..')
const SEATS = ['account_lead', 'brief_writer', 'claims_checker','design_lead', 'director', 'fetcher', 'fixer', 'fizz_generator', 'go_specialist', 'growth_lead', 'house_generator', 'kotlin_specialist',
  'lua_specialist', 'measurer', 'outside_specialist', 'php_specialist', 'python_specialist', 'researcher', 'ruby_specialist', 'rust_specialist',
  'solana_specialist', 'solidity_specialist', 'swift_specialist', 'text_review', 'typescript_specialist', 'web_specialist', 'writer']
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

test('D3: an absolute fence admits only writes under it', () => {
  const work = mkdtempSync(join(tmpdir(), 'cf-work-'))
  const out = join(work, 'rubin-post')
  const p = packet(seat(root, 'fetcher').manifest, 'p', 't', 'i', cwd, TRANSCRIPT, false, [out])
  for (const path of [`${out}/data.json`, `${out}/fetch.ts`]) expect(p.refuse(path)).toBeNull()
  for (const path of ['cli/x.ts', join(work, 'other/x'), '/etc/x']) expect(p.refuse(path)).toMatchObject({ origin_ref: 'seat.write_paths' })
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

test('a background Agent is denied and the seat goes on', () => {
  const ours = packet(seat(root, 'typescript_specialist').manifest, 'p', 't', 'i', cwd, TRANSCRIPT, true)
  const agent = (input: Record<string, unknown>): HookInput =>
    ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'd', prompt: 'p', ...input }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })
  const denied = gate(ours, agent({ run_in_background: true }))
  expect(denied).toMatchObject({ continue: true, hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'ruling:seat.tools refuses run_in_background: run it in the foreground and wait for it' } })
  expect(denied.stopReason).toBeUndefined()
  expect(gate(ours, agent({}))).toEqual({ continue: true })
  expect(gate(ours, agent({ run_in_background: false }))).toEqual({ continue: true })
})

const held = (tools: string[]): Packet => ({ prompt: 'p', cwd, transcript: TRANSCRIPT, model: 'm', effort: 'high', tools, refuse: () => null })
const denied = { continue: true, hookSpecificOutput: { permissionDecision: 'deny' } }

test('D1 a read-only seat may hold gh api, not gh', () => {
  const card = (tools: string[]) => ({ seat: 'account_lead', model: 'm', effort: 'low', tools, write_paths: [] })
  const gh = ['Read', 'Bash(cf look:*)', 'Bash(gh api:*)']
  expect(Seat.parse(card(gh)).tools).toEqual(gh)
  for (const tools of [['Read', 'Bash(gh:*)'], ['Read', 'Bash(gh pr:*)'], ['Read', 'Bash']]) {
    expect(() => Seat.parse(card(tools))).toThrow(/save Bash\(cf look:\*\)/)
  }
})

test('D2 D3 the gate admits a gh api read and denies its writes', () => {
  const p = held(['Read', 'Bash(gh api:*)'])
  expect(gate(p, bash('gh api repos/a/b/releases'))).toEqual({ continue: true })
  expect(gate(p, bash('gh api -X GET repos/a/b/pulls --paginate'))).toEqual({ continue: true })
  expect(gate(p, bash('gh api -iXGET \'repos/a/b/pulls?state=all\''))).toEqual({ continue: true })
  for (const command of ['gh api -X POST repos/a/b/issues', 'gh api -XPOST repos/a/b/issues', 'gh api --method=PATCH repos/a/b',
    'gh api repos/a/b/issues -f title=x', 'gh api repos/a/b -F n=1', 'gh api repos/a/b --raw-field=x=y', 'gh api repos/a/b --input body.json',
    'gh api repos/a/b/issues \'-f\' title=x', 'gh api repos/a/b/issues "-XPOST"', 'gh api -iXPOST repos/a/b/issues', 'gh api -iF n=1 repos/a/b/issues',
    'gh api repos/a/b/issues {-f,title=x}', 'gh api repos/a/b/issues \\-f title=x']) {
    expect(gate(p, bash(command))).toMatchObject(denied)
  }
})

test('D4 gh outside gh api is denied whatever pattern is held', () => {
  for (const tools of [['Bash(gh api:*)'], ['Bash(gh:*)']]) {
    for (const command of ['gh pr comment 1', 'gh issue create']) expect(gate(held(tools), bash(command))).toMatchObject(denied)
  }
})

const SUBMODULE = ['Read', 'Bash(git submodule add:*)']
const fenced = (paths: string[], tools = SUBMODULE): Packet => ({ ...held(tools), refuse: (path) => refuse(cwd, paths, path) })
const refusal = (command: string) => ({ continue: true, hookSpecificOutput: { permissionDecision: 'deny',
  permissionDecisionReason: `ruling:seat.tools refuses the command ${JSON.stringify(command)}` } })
const shapes = ['git submodule add https://github.com/foundry-rs/forge-std lib/forge-std', 'git -C lib/v4-core checkout 3f1c9a2']

test('1353a D1 D2 the gate admits a submodule add and its pin', () => {
  const p = fenced(['.gitmodules', 'lib'])
  for (const command of [...shapes, 'git submodule add https://github.com/foundry-rs/forge-std.git lib/forge-std',
    `git -C lib/v4-core checkout ${'a'.repeat(40)}`]) expect(gate(p, bash(command))).toEqual({ continue: true })
})

test('1353a D3 every other git is refused and the seat stays', () => {
  for (const p of [fenced(['.gitmodules', 'lib'], ['Read']), fenced(['lib']), held([])]) {
    for (const command of shapes) expect(gate(p, bash(command))).toMatchObject(refusal(command))
  }
  const p = fenced(['.gitmodules', 'lib'])
  const add = 'git submodule add https://github.com/foundry-rs/forge-std lib/forge-std'
  for (const command of ['git submodule add http://github.com/foundry-rs/forge-std lib/forge-std',
    'git submodule add ssh://github.com/foundry-rs/forge-std lib/forge-std', 'git submodule add https://gitlab.com/foundry-rs/forge-std lib/forge-std',
    'git submodule add https://github.com/foundry-rs/forge-std src/forge-std', 'git submodule add https://github.com/foundry-rs/forge-std lib/..',
    'git submodule add --force https://github.com/foundry-rs/forge-std lib/forge-std', `${add} --depth 1`,
    'git checkout 3f1c9a2', 'git -C lib/v4-core checkout 3f1c9a', 'git -C lib/v4-core checkout main',
    `${add} && rm -rf .`, `${add}; git push`, 'git status', 'git push']) expect(gate(p, bash(command))).toMatchObject(refusal(command))
})

const CLONE = ['Read', 'Bash(git clone:*)']
const clone = 'git clone https://github.com/solana-foundation/surfpool .cf/measure/surfpool'
const measured = [clone, 'git -C .cf/measure/surfpool checkout 2aee380']

test('1433a D1 the gate admits a measure clone and its pin', () => {
  const p = fenced(['.cf/measure'], CLONE)
  for (const command of [...measured, 'git clone https://github.com/solana-foundation/surfpool.git .cf/measure/surfpool',
    `git -C .cf/measure/surfpool checkout ${'a'.repeat(40)}`]) expect(gate(p, bash(command))).toEqual({ continue: true })
})

test('1433a D2 D3 every other git is refused and the seat stays', () => {
  for (const p of [fenced(['.cf/measure'], ['Read']), fenced(['src'], CLONE), held([])]) {
    for (const command of measured) expect(gate(p, bash(command))).toMatchObject(refusal(command))
  }
  const p = fenced(['.cf/measure'], CLONE)
  for (const command of ['git clone http://github.com/solana-foundation/surfpool .cf/measure/surfpool',
    'git clone ssh://github.com/solana-foundation/surfpool .cf/measure/surfpool', 'git clone https://gitlab.com/solana-foundation/surfpool .cf/measure/surfpool',
    'git clone https://github.com/solana-foundation/surfpool src/surfpool', 'git clone https://github.com/solana-foundation/surfpool .cf/measure/..',
    'git clone https://github.com/solana-foundation/surfpool .cf/measure/a/b',
    'git clone --depth 1 https://github.com/solana-foundation/surfpool .cf/measure/surfpool', `${clone} --depth 1`,
    `${clone} && rm -rf .`, `${clone}; git push`, 'git -C .cf/measure/surfpool checkout 2aee38', 'git -C .cf/measure/surfpool checkout main',
    'git checkout 2aee380', 'git status', 'git push']) expect(gate(p, bash(command))).toMatchObject(refusal(command))
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
  expect(new Set(rules(root).map((r) => r.path))).toEqual(new Set(['rules/rails.yaml', ...SEATS.map((s) => `rules/roster/${s}.yaml`), 'rules/tight.md', 'rules/senior.md', ...registered(root), 'rules/repo-classes.yaml', 'rules/staffing.yaml']))
  expect(ruleRows(db).length).toBe(loaded.length)
  load(db, root)
  expect(ruleRows(db).length).toBe(loaded.length)
})

test('seat() refuses one off the roster or with a drifted prompt', () => {
  expect(() => seat(root, 'nobody')).toThrow(/absent from rules\/roster\/nobody\.yaml/)
  const drifted = mkdtempSync(join(tmpdir(), 'cf-drift-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(drifted, dir), { recursive: true })
  appendFileSync(join(drifted, 'seats/typescript_specialist/prompt.md'), '\n')
  expect(() => seat(drifted, 'typescript_specialist')).toThrow(/prompt does not match its digest in rules\/roster\/typescript_specialist\.yaml/)
})

test('each seat file lists one seat and hashes its own', () => {
  expect(listed(root).seats).toEqual(SEATS)
  expect(listed(root).digests).toEqual(expected(root))
  for (const name of SEATS) expect(seat(root, name).hash).toBe(digest(join(root, `rules/roster/${name}.yaml`)))
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
  expect(runOf(db, id)).toMatchObject({
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
  expect(runOf(db, id)).toMatchObject({ cost_usd: 0.42 })
})

test('D6 cache writes stay in input_tokens and cache_write_tokens', async () => {
  const db = fresh(join(root, 'schema'))
  const usage = { m: { inputTokens: 10, cacheCreationInputTokens: 4, cacheReadInputTokens: 20, outputTokens: 0 } }
  const split = { cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 } }
  const written = fired(result({ result: 'done', modelUsage: usage, usage: split }), Date.now(), [])
  expect(written.usage).toMatchObject({ input: 14, cache: 20, write: 4, write_1h: 3 })
  const provider: Provider = { name: 'claude-agent-sdk', fire: (p) => Promise.resolve({ ...written, transcript_path: p.transcript }) }
  const { id } = await fire(db, root, 'typescript_specialist', cwd, 'ISSUE', provider)
  expect(runOf(db, id))
    .toMatchObject({ input_tokens: 14, cache_write_tokens: 4, cache_write_1h_tokens: 3, cache_read_tokens: 20 })
})
