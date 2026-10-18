import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gate, readOutside, walled } from '../../providers/claude-agent-sdk/index.ts'
import type { Fired, Packet, Provider } from '../../providers/kind.ts'
import { real } from '../../runner/index.ts'
import { seat } from '../../runner/rules.ts'
import { scores } from '../../store/bench.ts'
import { runRows } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { dial } from '../../store/lanes.ts'
import { allPlans, holdOn, pipeNamed, planById, putPlan, waiting, type PlanRow } from '../../store/plans.ts'
import { CEILING, generate, scored, scratch } from '../../templates/bench.ts'
import { unhold } from '../hold.ts'
import { dry, tick } from '../index.ts'
import { route } from '../next.ts'
import { kernel, mapOf } from '../steps.ts'
import { get, git, maybe, planDir, put, srcDir } from '../workspace.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 07:00 in Guatemala, when every lane's window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

function queued(db: Db, template: PlanRow['template'], step = 0): void {
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template, state: 'queued', queued_at: AT, step, retries: 0 })
}

test('a bench plan is stored and parsed', () => {
  const db = fresh(schema)
  queued(db, 'bench')
  expect(allPlans(db)).toMatchObject([{ id: 1, template: 'bench', state: 'queued', step: 0 }])
})

test('the bench map lists checkout, generate, score', () => {
  expect(mapOf('bench').steps.map((s) => s.name)).toEqual(['checkout', 'generate', 'score'])
})

test('the bench pipe routes its plan to step 0', () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench')
  expect(dry(db, OPENS).would).toContainEqual({ pipe: 'bench', plan: 1, step: 0, template: 'bench' })
  expect(route(db, planById(db, 1), OPENS)).toEqual({ fire: mapOf('bench').at(0) })
})

test('an unknown template and a step past score are refused', () => {
  const db = fresh(schema)
  expect(() => { queued(db, 'nonsense' as PlanRow['template']) }).toThrow(/CHECK constraint failed/)
  expect(() => mapOf('bench').at(3)).toThrow('bench has no step 3')
})

const FINDING = 'convertToShares rounds the share price down'

function commit(dir: string, path: string, body: string, message: string): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), body)
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** `<root>/remotes/org/fixture`: c1, then c2, the fix, which adds the report. */
function fixture(body = 'export const vault = 1\n', message = 'vault'): { root: string; c1: string; c2: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  const dir = join(root, 'remotes/org/fixture')
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  const c1 = commit(dir, 'src/vault.ts', body, message)
  const c2 = commit(dir, 'audits/report-m01.md', `# M-01\n\n${FINDING}\n`, 'fix: share price rounds down')
  mkdirSync(join(root, '.cf'))
  writeFileSync(join(root, '.cf/git-base'), join(root, 'remotes'))
  return { root, c1, c2 }
}

function target(root: string, keys: Record<string, string>): void {
  put(root, 1, 'target.yml', Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join('\n'))
}

function benched(): PlanRow {
  const db = fresh(schema)
  queued(db, 'bench')
  return planById(db, 1)
}

test('kernel checks out the pre-fix sha and writes checkout.json', () => {
  const { root, c1, c2 } = fixture()
  const fix = c2.slice(0, 12)
  target(root, { repo: 'org/fixture', fix, pre_fix: `${fix}^`, report: 'audits/report-m01.md', finding: FINDING })
  const db = fresh(schema)
  queued(db, 'bench')
  expect(kernel(db, root, planById(db, 1))).toEqual({ outcome: 'pass', spans: [], note: `checkout.json written at ${c1.slice(0, 12)}` })
  const dir = srcDir(root, 1)
  expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(c1)
  expect(spawnSync('git', ['cat-file', '-e', `${c2}^{commit}`], { cwd: dir }).status).not.toBe(0)
  expect(JSON.parse(get(root, 1, 'checkout.json'))).toEqual({ repo: 'org/fixture', fix, pre_fix: c1 })
  expect(existsSync(join(planDir(root, 1), 'resolve.git'))).toBe(false)
})

test('a fix the scratch tree holds is refused', () => {
  const { root, c1 } = fixture()
  target(root, { repo: 'org/fixture', fix: c1, pre_fix: c1 })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.fix_reachable'] })
  expect(maybe(root, 1, 'checkout.json')).toBeNull()
})

test('a pre-fix file holding the finding text is refused', () => {
  const { root, c2 } = fixture(`// ${FINDING}\n`)
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: `${c2}^`, finding: FINDING })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.seen'], note: `"${FINDING}" is in the file src/vault.ts` })
})

test('a pre-fix commit message naming the report is refused', () => {
  const { root, c2 } = fixture(undefined, 'see report-m01.md')
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: `${c2}^`, report: 'audits/report-m01.md' })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.seen'], note: '"report-m01.md" is in a commit message' })
})

test('a missing or incomplete target.yml is refused', () => {
  const { root, c2 } = fixture()
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['target.yml'] })
  target(root, { repo: 'org/fixture', fix: c2 })
  expect(scratch(root, benched())).toEqual({ outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no pre_fix' })
})

const REPO = join(import.meta.dirname, '../..')

function staffedIn(root: string): void {
  for (const dir of ['rules', 'seats']) cpSync(join(REPO, dir), join(root, dir), { recursive: true })
}

/** A generator that spends `tokens`, ends `ended` and writes `wrote`, or test/fizz/FizzTest.sol when `wrote` is true, and when `xray`, x-ray/x-ray.md. */
function stub(tokens: number, ended: Fired['ended'], wrote: boolean | string[], stop: string | null = null, xray = false): { provider: Provider; packets: Packet[] } {
  const packets: Packet[] = []
  return { packets, provider: { name: 'claude-agent-sdk', fire: (packet) => {
    packets.push(packet)
    expect(walled(packet.wall, CEILING)).not.toBeNull()
    for (const path of wrote === true ? ['test/fizz/FizzTest.sol'] : wrote === false ? [] : wrote) {
      mkdirSync(dirname(join(packet.cwd, path)), { recursive: true })
      writeFileSync(join(packet.cwd, path), 'contract FizzTest {}\n')
    }
    if (xray) {
      mkdirSync(join(packet.cwd, 'x-ray'), { recursive: true })
      writeFileSync(join(packet.cwd, 'x-ray/x-ray.md'), '# x-ray\n')
    }
    return Promise.resolve({ text: '', transcript_path: packet.transcript, usage: { input: tokens - 1000, cache: 0, output: 1000 }, seconds: 1,
      ended, exit: ended === 'completed' ? 0 : 1, stop_reason: stop, denials: 0 })
  } } }
}

/** src/ cloned at one commit, and the checkout.json naming it as pre_fix. */
function checkedOut(root: string): void {
  const dir = srcDir(root, 1)
  git(dir, ['init', '-q'])
  put(root, 1, 'checkout.json', JSON.stringify({ pre_fix: commit(dir, 'src/Vault.sol', 'contract Vault {}\n', 'vault') }))
}

/** An empty src/ inside a repo whose HEAD checkout.json names as pre_fix, so only `cloned` tells them apart. */
function emptied(root: string): void {
  git(root, ['init', '-q'])
  put(root, 1, 'checkout.json', JSON.stringify({ pre_fix: commit(root, 'README.md', '', 'root') }))
  srcDir(root, 1)
}

async function generated(fired: ReturnType<typeof stub>, keys: Record<string, string> = { generator: 'fizz' },
  ready: (root: string) => void = checkedOut, root = mkdtempSync(join(tmpdir(), 'cf-bench-'))) {
  staffedIn(root)
  ready(root)
  target(root, keys)
  const db = fresh(schema)
  queued(db, 'bench')
  return { root, db, outcome: await generate(db, root, planById(db, 1), mapOf('bench').at(1), fired.provider) }
}

const bash = (command: string): HookInput => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }) as unknown as HookInput

test('D1 D7 tick fires fizz_generator in the scratch tree', async () => {
  const { root, c1, c2 } = fixture()
  staffedIn(root)
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: `${c2}^`, report: 'audits/report-m01.md', finding: FINDING, generator: 'fizz' })
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench')
  const fired = stub(CEILING, 'stopped', true)
  await tick(db, root, fired.provider, OPENS)
  expect(planById(db, 1).step).toBe(1)
  await tick(db, root, fired.provider, OPENS)
  expect(fired.packets).toMatchObject([{ cwd: realpathSync(srcDir(root, 1)), wall: CEILING, tools: seat(root, 'fizz_generator').manifest.tools }])
  expect(git(srcDir(root, 1), ['rev-parse', 'HEAD']).trim()).toBe(c1)
  expect(planById(db, 1).step).toBe(2)
  for (const said of [c2, c2.slice(0, 12), FINDING]) expect(fired.packets[0]?.prompt).not.toContain(said)
})

const SKILL = join(homedir(), '.claude/skills/fizz')

const XRAY = join(homedir(), '.claude/skills/x-ray')

const ATTEMPTS = '/tmp/x-ray-attempts.md'

test('D2 D3 generate admits fizz Step 1-2 and cd cwd, denies curl', async () => {
  const fired = stub(CEILING, 'stopped', true)
  await generated(fired)
  const [packet] = fired.packets
  if (packet === undefined) throw new Error('the generator was not fired')
  const cwd = packet.cwd
  for (const command of ['pwd', 'forge --version', 'medusa --version', 'echidna --version', `bash ${SKILL}/scripts/ensure_foundry.sh ${cwd}`,
    `node ${SKILL}/scripts/extract_abis.js ${cwd} --meta-dir test/fizz/fizz_data`, 'FOUNDRY_PROFILE=fuzz forge build',
    `cd ${cwd} && forge build`, `cd "${cwd}" && forge build`, `cd ${cwd} && FOUNDRY_PROFILE=fuzz forge test --match-contract FoundryTester -vvv`,
    `rm -f ${ATTEMPTS}`]) {
    expect(gate(packet, bash(command))).toEqual({ continue: true })
  }
  for (const command of ['curl https://example.com', 'cd /tmp && forge build', `cd ${cwd}/.. && forge build`, `cd ${cwd} && curl https://example.com`,
    `cd ${cwd} && forge build | tail -5`, `cd ${cwd} && forge build && curl x`, 'cd "$(curl x)/.." && forge build', 'cd "`curl x`/.." && forge build',
    'cd $(curl${IFS}x)/.. && forge build', 'cd ~/.. && forge build', `rm -rf ${ATTEMPTS}`, 'rm -f /tmp/other.md', `rm -f ${ATTEMPTS}; curl x`,
    'git clone --depth 1 https://github.com/pashov/skills.git /tmp/pashov-skills-xray-install']) {
    expect(gate(packet, bash(command)).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
    expect(JSON.stringify(gate(packet, bash(command)))).toContain('ruling:seat.tools')
  }
})

test('D2 D4 D5 fizz reads fizz, x-ray and the attempts file', async () => {
  const fired = stub(CEILING, 'stopped', true)
  await generated(fired)
  const [packet] = fired.packets
  if (packet === undefined) throw new Error('the generator was not fired')
  expect(packet.reads).toEqual([real(SKILL), real(XRAY), real(ATTEMPTS)])
  for (const path of [join(SKILL, 'references/template-map.md'), join(XRAY, 'SKILL.md'), ATTEMPTS]) {
    expect(readOutside(packet.cwd, 'Read', { file_path: path }, packet.reads)).toBeNull()
  }
  for (const path of [join(homedir(), '.claude/skills/other/SKILL.md'), '/tmp/other.md']) {
    expect(readOutside(packet.cwd, 'Read', { file_path: path }, packet.reads)).toContain('run.outside_checkout')
  }
  for (const path of [ATTEMPTS, join(packet.cwd, 'x-ray/x-ray.md'), join(packet.cwd, 'medusa.json')]) expect(packet.refuse(path)).toBeNull()
  for (const path of ['/tmp/other.md', join(packet.cwd, 'README.md'), join(packet.cwd, 'src/medusa.json')]) {
    expect(packet.refuse(path)).toMatchObject({ origin_ref: 'seat.write_paths' })
  }
  expect(packet.prompt).toContain(`SKILL_PATH is ${real(SKILL)}.`)
  expect(packet.prompt).toContain(`${real(XRAY)}/SKILL.md`)
  expect(packet.env).toEqual({ BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000' })
  expect(packet.prompt).toContain('Run forge in the foreground, never in the background, and do not end the turn while waiting on a build.')
})

test('D1 D2 a root reached through a symlink gets real paths', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  mkdirSync(join(elsewhere, '.cf'))
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  symlinkSync(join(elsewhere, '.cf'), join(root, '.cf'))
  const fired = stub(CEILING, 'stopped', true)
  await generated(fired, undefined, checkedOut, root)
  const [packet] = fired.packets
  if (packet === undefined) throw new Error('the generator was not fired')
  expect(packet.cwd).toBe(join(realpathSync(elsewhere), '.cf/work/1/src'))
  expect(packet.reads).toEqual([real(SKILL), real(XRAY), real(ATTEMPTS)])
  for (const dir of [srcDir(root, 1), packet.cwd]) {
    expect(readOutside(packet.cwd, 'Read', { file_path: join(dir, 'src/Vault.sol') }, packet.reads)).toBeNull()
  }
})

test('D3 D4 generate refuses a src/ not at pre_fix, unfired', async () => {
  const moved = (root: string) => { checkedOut(root); commit(srcDir(root, 1), 'src/Moved.sol', '', 'moved') }
  const unwritten = (root: string) => { checkedOut(root); rmSync(join(planDir(root, 1), 'checkout.json')) }
  for (const ready of [emptied, moved, unwritten]) {
    const fired = stub(CEILING, 'stopped', true)
    const { db, outcome } = await generated(fired, undefined, ready)
    expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_checkout'], to: 0 })
    expect(fired.packets).toEqual([])
    expect(runRows(db)).toEqual([])
  }
})

test('D5 tick on an empty src/ sends the plan back to step 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  staffedIn(root)
  emptied(root)
  target(root, { generator: 'fizz' })
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench', 1)
  await tick(db, root, stub(CEILING, 'stopped', true).provider, OPENS)
  expect(planById(db, 1).step).toBe(0)
  expect(planById(db, 1).state).not.toBe('blocked_on_ceo')
})

test('D3 cf return --to 1 on a NULL-lane bench plan fires it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  staffedIn(root)
  emptied(root)
  target(root, { generator: 'fizz' })
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench', 2)
  holdOn(db, 1, 'held', null)
  waiting(db, [{ plan: 1, why: 'leased' }])
  unhold(db, root, 1, 'coo', 1)
  expect(await tick(db, root, stub(CEILING, 'stopped', true).provider, OPENS)).toMatchObject([{ plan: 1, step: 1 }])
  expect(planById(db, 1).lane).toBeNull()
})

test('D3 a run stopped at the ceiling with a suite passes', async () => {
  const { root, db, outcome } = await generated(stub(CEILING + 5, 'stopped', true, 'ruling:run.token_wall'))
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(root, 1, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: CEILING + 5, seconds: 1, x_ray: 0 })
  expect(runRows(db)).toMatchObject([{ seat: 'fizz_generator', staffed: 'fizz_generator' }])
})

test('D2 generate.json has x_ray 1 when x-ray.md was written', async () => {
  const { root } = await generated(stub(1000, 'completed', true, null, true))
  expect(JSON.parse(get(root, 1, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: 1000, seconds: 1, x_ray: 1 })
})

test('D4 a completed run with no suite is refused', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', false))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_suite'] })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('D1 a suite of only fizz_data notes is refused', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', ['test/fizz/fizz_data/protocol-understanding.md', 'test/fizz/fizz_data/x-ray-attempts.md']))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_suite'] })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('D2 a .sol only under fizz_data is refused', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', ['test/fizz/fizz_data/FizzTest.sol']))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_suite'] })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('D5 a stop under the ceiling is refused on its reason', async () => {
  const why = 'ruling:seat.write_paths refuses a write to src/vault.sol'
  const { root, outcome } = await generated(stub(1000, 'stopped', true, why))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: [why] })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('D6 no generator is refused, an unstaffed one needs the ceo', async () => {
  expect((await generated(stub(0, 'completed', false), {})).outcome).toMatchObject({ outcome: 'refuse', spans: ['target.yml'] })
  expect((await generated(stub(0, 'completed', false), { generator: 'nobody' })).outcome).toMatchObject({ outcome: 'needs_ceo', spans: ['staffing'] })
})

const PAIRS = [{ property: 'p1', verdict: 'catch' }, { property: 'p2', verdict: 'catch' }, { property: 'p3', verdict: 'fp_candidate' },
  { property: 'p4', verdict: 'silent' }]

const KILLS = [{ property: 'p1', kills: 3, untested: false }, { property: 'p4', kills: 0, untested: true }]

/** A stub fuzz-bench script that writes `rows` to `results/<suite>/<suite><suffix>`. */
function writes(suffix: string, rows: object[]): string {
  const body = JSON.stringify(rows.map((r) => JSON.stringify(r)).join('\n'))
  return `import os, sys\nname = os.path.basename(sys.argv[2])\nos.makedirs(f'results/{name}', exist_ok=True)\nopen(f'results/{name}/{name}${suffix}', 'w').write(${body})\n`
}

/** A bench plan at score with its suite written, and `remotes/caliperforge/fuzz-bench` whose run_pair.py is `pair`. */
function scoring(pair = writes('.jsonl', PAIRS), keys: Record<string, string> = { target: 'euler-earn-m01', generator: 'fizz' }) {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  const dir = join(root, 'remotes/caliperforge/fuzz-bench')
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  commit(dir, 'bench/null_check.py', writes('.nullcheck.jsonl', KILLS), 'null check')
  const sha = commit(dir, 'bench/run_pair.py', pair, 'run pair')
  mkdirSync(join(root, '.cf'))
  writeFileSync(join(root, '.cf/git-base'), join(root, 'remotes'))
  mkdirSync(join(srcDir(root, 1), 'test/fizz'), { recursive: true })
  writeFileSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'), 'contract FizzTest {}\n')
  checkedOut(root)
  target(root, keys)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5 }))
  const db = fresh(schema)
  queued(db, 'bench', 2)
  return { root, db, sha }
}

const SCORE = { catches: 2, false_positives: 1, untested: 1, tokens: 1234, seconds: 56.5 }

test('score D1 kernel scores the suite at the fuzz-bench HEAD', () => {
  const { root, db, sha } = scoring()
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', ...SCORE, x_ray: null }])
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/FizzTest.sol'))).toBe(true)
  expect(existsSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'))).toBe(true)
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...SCORE, x_ray: null })
})

test('score D2 a failing run_pair.py is refused and not recorded', () => {
  const { root, db } = scoring('import sys\nsys.stderr.write("forge build failed")\nsys.exit(1)\n')
  expect(scored(db, root, planById(db, 1))).toEqual({ outcome: 'refuse', spans: ['bench.run_pair'], note: 'forge build failed' })
  expect(scores(db)).toEqual([])
})

test('D3 an empty results file is refused and not recorded', () => {
  const { root, db } = scoring(writes('.jsonl', []))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'refuse', spans: ['bench.empty_results'] })
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
})

test('score D3 no target or no generate.json is refused uncloned', () => {
  const { root, db } = scoring(undefined, { generator: 'fizz' })
  expect(scored(db, root, planById(db, 1))).toEqual({ outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no target' })
  target(root, { target: 'euler-earn-m01', generator: 'fizz' })
  rmSync(join(planDir(root, 1), 'generate.json'))
  expect(scored(db, root, planById(db, 1))).toEqual({ outcome: 'refuse', spans: ['generate.json'], note: 'generate.json is missing' })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench'))).toBe(false)
})

test('D3 house_generator generates and is scored under its name', async () => {
  const { root, db } = scoring(undefined, { target: 'euler-earn-m01', generator: 'house_generator' })
  staffedIn(root)
  const fired = stub(1234, 'completed', true)
  expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), fired.provider)).toMatchObject({ outcome: 'pass' })
  expect(fired.packets).toMatchObject([{ tools: seat(root, 'house_generator').manifest.tools }])
  expect(fired.packets[0]?.reads).toEqual([real(ATTEMPTS)])
  expect(fired.packets[0]?.prompt).not.toContain('SKILL_PATH')
  expect(runRows(db)).toMatchObject([{ seat: 'house_generator', staffed: 'house_generator' }])
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'house_generator', ...SCORE, tokens: 1234, seconds: 1, x_ray: 0 }])
})

test('D3 a run that wrote x-ray.md is scored with x_ray 1', async () => {
  const { root, db, sha } = scoring(undefined, { target: 'euler-earn-m01', generator: 'house_generator' })
  staffedIn(root)
  expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), stub(1234, 'completed', true, null, true).provider))
    .toMatchObject({ outcome: 'pass' })
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ plan: 1, x_ray: 1 }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...SCORE, seconds: 1, x_ray: 1 })
})

test('score D5 a comms plan still reaches the comms scorer', () => {
  const db = fresh(schema)
  queued(db, 'comms', mapOf('comms').steps.length - 1)
  expect(kernel(db, mkdtempSync(join(tmpdir(), 'cf-bench-')), planById(db, 1))).toEqual({ outcome: 'pass', spans: [], note: 'not a scorecard plan' })
})
