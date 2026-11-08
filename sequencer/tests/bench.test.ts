import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gate, readOutside, walled } from '../../providers/claude-agent-sdk/index.ts'
import type { Fired, Packet, Provider } from '../../providers/kind.ts'
import { real } from '../../runner/index.ts'
import { seat } from '../../runner/rules.ts'
import { medusaFile, rescore } from '../../cli/bench.ts'
import { record, scores, supersede, type Score } from '../../store/bench.ts'
import { eventsAfter, eventsOf, logged, runRows, type Event } from '../../store/events.ts'
import { holdOf } from '../../store/holds.ts'
import { addRun } from '../../store/brief.ts'
import { dropSettings } from '../../store/drift.ts'
import { type Db, upsertRule } from '../../store/index.ts'
import { dial, set } from '../../store/lanes.ts'
import { allPlans, end, holdOn, pipeNamed, planById, putPlan, requeue, waiting, type PlanRow } from '../../store/plans.ts'
import { refusalRows } from '../../store/refusals.ts'
import { CEILING, generate, nullChecked, scored, scratch } from '../../templates/bench.ts'
import { costWall } from '../../templates/generated.ts'
import { counted, powered } from '../../templates/powered.ts'
import { KINDS } from '../../templates/report.ts'
import { drift, mechanisms } from '../drift.ts'
import { evict } from '../evict.ts'
import { hold, unhold } from '../hold.ts'
import { dry, tick } from '../index.ts'
import { route } from '../next.ts'
import { kernel, mapOf } from '../steps.ts'
import { get, git, maybe, planDir, put, reap, srcDir } from '../workspace.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 07:00 in Guatemala, when every lane's window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

/** 23:00 in Guatemala, inside the refuzz pipe's window, when a bench plan may score. */
const NIGHT = new Date('2026-09-19T05:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

afterEach(() => { vi.unstubAllEnvs() })

function queued(db: Db, template: PlanRow['template'], step = 0): void {
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template, state: 'queued', queued_at: AT, step, retries: 0 })
}

test('a bench plan is stored and parsed', () => {
  const db = fresh(schema)
  queued(db, 'bench')
  expect(allPlans(db)).toMatchObject([{ id: 1, template: 'bench', state: 'queued', step: 0 }])
})

test('the bench map lists checkout, generate, score, null_check', () => {
  expect(mapOf('bench').steps.map((s) => s.name)).toEqual(['checkout', 'generate', 'score', 'null_check'])
})

test('the bench pipe routes its plan to step 0', () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench')
  expect(dry(db, OPENS).would).toContainEqual({ pipe: 'bench', plan: 1, step: 0, template: 'bench' })
  expect(route(db, planById(db, 1), OPENS)).toEqual({ fire: mapOf('bench').at(0) })
})

test('an unknown template and a step past null_check are refused', () => {
  const db = fresh(schema)
  expect(() => { queued(db, 'nonsense' as PlanRow['template']) }).toThrow(/CHECK constraint failed/)
  expect(() => mapOf('bench').at(4)).toThrow('bench has no step 4')
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

/** Adds `lib/dep`, a submodule of `remotes/org/dep` whose `.gitmodules` url is `url`, to `remotes/org/fixture`; the commit adding it. */
function submoduled(root: string, url = join(root, 'remotes/org/dep')): string {
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.file.allow')
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'always')
  const dep = join(root, 'remotes/org/dep')
  mkdirSync(dep, { recursive: true })
  git(dep, ['init', '-q'])
  commit(dep, 'Dep.sol', 'contract Dep {}\n', 'dep')
  const dir = join(root, 'remotes/org/fixture')
  git(dir, ['submodule', 'add', '-q', dep, 'lib/dep'])
  return commit(dir, '.gitmodules', `[submodule "lib/dep"]\n\tpath = lib/dep\n\turl = ${url}\n`, 'dep')
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

test('a pre-fix with submodules is checked out with them', () => {
  const { root, c2 } = fixture()
  const c3 = submoduled(root)
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: c3 })
  expect(scratch(root, benched())).toEqual({ outcome: 'pass', spans: [], note: `checkout.json written at ${c3.slice(0, 12)}` })
  expect(readFileSync(join(srcDir(root, 1), 'lib/dep/Dep.sol'), 'utf8')).toBe('contract Dep {}\n')
})

test('a submodule origin does not hold throws', () => {
  const { root, c2 } = fixture()
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: submoduled(root, join(root, 'remotes/org/gone')) })
  expect(() => scratch(root, benched())).toThrow()
  expect(maybe(root, 1, 'checkout.json')).toBeNull()
})

test('a fix the scratch tree holds is refused', () => {
  const { root, c1 } = fixture()
  target(root, { repo: 'org/fixture', fix: c1, pre_fix: c1 })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.fix_reachable'] })
  expect(maybe(root, 1, 'checkout.json')).toBeNull()
})

/** A commit on c1 that only `refs/pull/1/head` reaches, served over file:// so a clone gets only advertised refs. */
function pulled(root: string, c1: string): string {
  const dir = join(root, 'remotes/org/fixture')
  git(dir, ['checkout', '-qb', 'pr', c1])
  const pr = commit(dir, 'src/pr.ts', 'export const pr = 1\n', 'pr')
  git(dir, ['update-ref', 'refs/pull/1/head', pr])
  git(dir, ['checkout', '-q', '-'])
  git(dir, ['branch', '-qD', 'pr'])
  writeFileSync(join(root, '.cf/git-base'), `file://${join(root, 'remotes')}`)
  symlinkSync('fixture', `${dir}.git`)
  return pr
}

test('a pre-fix sha only a pull ref reaches is fetched', () => {
  const { root, c1, c2 } = fixture()
  const pr = pulled(root, c1)
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: pr })
  expect(scratch(root, benched())).toEqual({ outcome: 'pass', spans: [], note: `checkout.json written at ${pr.slice(0, 12)}` })
  expect(git(srcDir(root, 1), ['rev-parse', 'HEAD']).trim()).toBe(pr)
})

test('a full-sha pre-fix is fetched without its history', () => {
  const { root, c1, c2 } = fixture()
  const dir = join(root, 'remotes/org/fixture')
  rmSync(join(dir, '.git/objects', c1.slice(0, 2), c1.slice(2)))
  writeFileSync(join(root, '.cf/git-base'), `file://${join(root, 'remotes')}`)
  symlinkSync('fixture', `${dir}.git`)
  target(root, { repo: 'org/fixture', fix: 'f'.repeat(40), pre_fix: c2 })
  expect(scratch(root, benched())).toEqual({ outcome: 'pass', spans: [], note: `checkout.json written at ${c2.slice(0, 12)}` })
  expect(git(srcDir(root, 1), ['rev-parse', 'HEAD']).trim()).toBe(c2)
})

test('a pull-only fix resolves its parent as pre-fix', () => {
  const { root, c1 } = fixture()
  const pr = pulled(root, c1)
  target(root, { repo: 'org/fixture', fix: pr, pre_fix: `${pr}^` })
  expect(scratch(root, benched())).toEqual({ outcome: 'pass', spans: [], note: `checkout.json written at ${c1.slice(0, 12)}` })
})

test('a full-sha pre-fix origin does not hold throws', () => {
  const { root, c2 } = fixture()
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: 'f'.repeat(40) })
  expect(() => scratch(root, benched())).toThrow()
  expect(maybe(root, 1, 'checkout.json')).toBeNull()
  expect(existsSync(join(planDir(root, 1), 'resolve.git'))).toBe(false)
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

const suite = (properties: number): string => `contract FizzTest {\n${'  function invariant_holds() public {}\n'.repeat(properties)}}\n`

const BODY = suite(3)

/** A generator that spends `tokens`, ends `ended` and writes `body` to `wrote`, or test/fizz/FizzTest.sol when `wrote` is true, when `xray`, x-ray/x-ray.md, and a transcript spawning `agents` sub-agents. */
function stub(tokens: number, ended: Fired['ended'], wrote: boolean | string[], stop: string | null = null, xray = false,
  body = BODY, agents = 8): { provider: Provider; packets: Packet[] } {
  const packets: Packet[] = []
  return { packets, provider: { name: 'claude-agent-sdk', fire: (packet) => {
    packets.push(packet)
    expect(walled(packet.wall, CEILING)).not.toBeNull()
    for (const path of wrote === true ? ['test/fizz/FizzTest.sol'] : wrote === false ? [] : wrote) {
      mkdirSync(dirname(join(packet.cwd, path)), { recursive: true })
      writeFileSync(join(packet.cwd, path), body)
    }
    if (xray) {
      mkdirSync(join(packet.cwd, 'x-ray'), { recursive: true })
      writeFileSync(join(packet.cwd, 'x-ray/x-ray.md'), '# x-ray\n')
    }
    const spawn = { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'general-purpose' } }
    if (agents > 0) writeFileSync(packet.transcript, `${JSON.stringify({ type: 'assistant', message: { content: Array(agents).fill(spawn) } })}\n`)
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

/** An empty src/ and a checkout.json naming `repo` at `preFix`, as `reap` leaves a bench plan. */
function reaped(preFix: string, fix = ''): (root: string) => void {
  return (root) => {
    put(root, 1, 'checkout.json', JSON.stringify({ repo: 'org/fixture', fix, pre_fix: preFix }))
    srcDir(root, 1)
  }
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
  const fired = stub(1000, 'completed', true)
  await tick(db, root, fired.provider, OPENS)
  expect(planById(db, 1).step).toBe(1)
  await tick(db, root, fired.provider, OPENS)
  expect(fired.packets).toMatchObject([{ cwd: realpathSync(srcDir(root, 1)), wall: 6_000_000, tools: seat(root, 'fizz_generator').manifest.tools }])
  expect(walled(fired.packets[0]?.wall, 400_001)).toBeNull()
  expect(git(srcDir(root, 1), ['rev-parse', 'HEAD']).trim()).toBe(c1)
  expect(planById(db, 1).step).toBe(2)
  for (const said of [c2, c2.slice(0, 12), FINDING]) expect(fired.packets[0]?.prompt).not.toContain(said)
})

const SKILL = join(homedir(), '.claude/skills/fizz')

const XRAY = join(homedir(), '.claude/skills/x-ray')

const ATTEMPTS = '/tmp/x-ray-attempts.md'

test('D2 D3 generate admits fizz Step 1-2 and cd cwd, denies curl', async () => {
  const fired = stub(1000, 'completed', true)
  await generated(fired)
  const [packet] = fired.packets
  if (packet === undefined) throw new Error('the generator was not fired')
  const cwd = packet.cwd
  for (const command of ['pwd', 'forge --version', 'medusa --version', 'echidna --version', `bash ${SKILL}/scripts/ensure_foundry.sh ${cwd}`,
    `node ${SKILL}/scripts/extract_abis.js ${cwd} --meta-dir test/fizz/fizz_data`, 'FOUNDRY_PROFILE=fuzz forge build',
    `cd ${cwd} && forge build`, `cd "${cwd}" && forge build`, `cd ${cwd} && FOUNDRY_PROFILE=fuzz forge test --match-contract FoundryTester -vvv`,
    `rm -f ${ATTEMPTS}`, 'mkdir -p x-ray', `cd ${cwd} && mkdir -p x-ray`, `python3 ${XRAY}/scripts/analyze_git_security.py ${cwd}`]) {
    expect(gate(packet, bash(command))).toEqual({ continue: true })
  }
  for (const command of ['curl https://example.com', 'cd /tmp && forge build', `cd ${cwd}/.. && forge build`, `cd ${cwd} && curl https://example.com`,
    `cd ${cwd} && forge build | tail -5`, `cd ${cwd} && forge build && curl x`, 'cd "$(curl x)/.." && forge build', 'cd "`curl x`/.." && forge build',
    'cd $(curl${IFS}x)/.. && forge build', 'cd ~/.. && forge build', `rm -rf ${ATTEMPTS}`, 'rm -f /tmp/other.md', `rm -f ${ATTEMPTS}; curl x`,
    'git clone --depth 1 https://github.com/pashov/skills.git /tmp/pashov-skills-xray-install', 'mkdir -p /tmp/x', 'mkdir x-ray',
    'mkdir -p x-ray && curl x', 'python3 a.py | tail -5', 'python3 a.py > x-ray/out']) {
    expect(gate(packet, bash(command)).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
    expect(JSON.stringify(gate(packet, bash(command)))).toContain('ruling:seat.tools')
  }
})

test('D2 D4 D5 fizz reads fizz, x-ray and the attempts file', async () => {
  const fired = stub(1000, 'completed', true)
  const { root } = await generated(fired)
  const [packet] = fired.packets
  if (packet === undefined) throw new Error('the generator was not fired')
  const tmp = real(join(planDir(root, 1), 'scratch'))
  expect(existsSync(tmp)).toBe(true)
  expect(packet.reads).toEqual([real(SKILL), real(XRAY), real(ATTEMPTS)])
  for (const path of [join(SKILL, 'references/template-map.md'), join(XRAY, 'SKILL.md'), ATTEMPTS]) {
    expect(readOutside(packet.cwd, 'Read', { file_path: path }, packet.reads)).toBeNull()
  }
  for (const path of [join(homedir(), '.claude/skills/other/SKILL.md'), '/tmp/other.md']) {
    expect(readOutside(packet.cwd, 'Read', { file_path: path }, packet.reads)).toContain('run.outside_checkout')
  }
  for (const path of [ATTEMPTS, join(tmp, 'fizz_list_fns.js'), join(packet.cwd, 'x-ray/x-ray.md'),
    ...['medusa.json', 'PROPERTIES.md', 'echidna.yaml', 'foundry.toml'].map((f) => join(packet.cwd, f))]) {
    expect(packet.refuse(path)).toBeNull()
  }
  for (const path of ['/tmp/other.md', '/tmp/fizz_inspect_1806.py', ...['README.md', 'src/medusa.json', 'src/PROPERTIES.md'].map((f) => join(packet.cwd, f))]) {
    expect(packet.refuse(path)).toMatchObject({ origin_ref: 'seat.write_paths' })
  }
  expect(packet.prompt).toContain(`SKILL_PATH is ${real(SKILL)}.`)
  expect(packet.prompt).toContain(`${real(XRAY)}/SKILL.md`)
  expect(packet.prompt).toContain('Run x-ray\'s scripts as bash <script> and python3 <script> from PROJECT_ROOT, with no pipe, redirection or $.')
  expect(packet.env).toEqual({ BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', TMPDIR: tmp })
  expect(packet.prompt).toContain(`Write throwaway scripts and notes under $TMPDIR, never /tmp. $TMPDIR is ${tmp}.`)
  expect(packet.prompt).toContain('Run forge in the foreground, never in the background, and do not end the turn while waiting on a build.')
  expect(packet.prompt).toContain('add properties to test/fizz/Properties.sol one at a time and save the file after each; write property-plan.md')
  expect(packet.idle).toBe(60)
})

test('D1 D2 a root reached through a symlink gets real paths', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  mkdirSync(join(elsewhere, '.cf'))
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  symlinkSync(join(elsewhere, '.cf'), join(root, '.cf'))
  const fired = stub(1000, 'completed', true)
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
  const unknown = 'f'.repeat(40)
  const unfetched = reaped(unknown)
  for (const [ready, note] of [[emptied, 'src/ is not a clone'], [moved, expect.stringMatching(/^src\/ is at \w{12}, not pre_fix \w{12}$/) as string],
    [unwritten, 'checkout.json is missing'], [unfetched, `src/ could not be cloned again at ${unknown.slice(0, 12)}`]] as const) {
    const fired = stub(1000, 'completed', true)
    const { db, outcome } = await generated(fired, undefined, ready, fixture().root)
    expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_checkout'], note, to: 0 })
    expect(fired.packets).toEqual([])
    expect(runRows(db)).toEqual([])
    expect(eventsOf(db, 1, 'swallowed').map((e) => e.actor)).toEqual(ready === unfetched ? ['generate'] : [])
  }
})

test('D1 generate clones an emptied src/ again at pre_fix', async () => {
  const { root, c2 } = fixture()
  const c3 = submoduled(root)
  const fired = stub(1000, 'completed', true)
  expect((await generated(fired, undefined, reaped(c3, c2), root)).outcome).toMatchObject({ outcome: 'pass' })
  expect(fired.packets).toMatchObject([{ cwd: realpathSync(srcDir(root, 1)) }])
  expect(git(srcDir(root, 1), ['rev-parse', 'HEAD']).trim()).toBe(c3)
  expect(existsSync(join(srcDir(root, 1), 'lib/dep/Dep.sol'))).toBe(true)
})

const HALF = 'contract FizzTest {\n'

/** A generate on `root` that wrote half a suite and died mid-run, its transcript buried by `evict` under the dead pid returned. */
function died(root: string, ready: (root: string) => void = () => undefined): number {
  const provider: Provider = { name: 'claude-agent-sdk', fire: (packet) => {
    mkdirSync(join(packet.cwd, 'test/fizz'), { recursive: true })
    writeFileSync(join(packet.cwd, 'test/fizz/FizzTest.sol'), HALF)
    writeFileSync(packet.transcript, '')
    return new Promise<never>(() => undefined)
  } }
  void generated({ provider, packets: [] }, undefined, ready, root)
  const db = fresh(schema)
  queued(db, 'bench')
  const dead = spawnSync('/usr/bin/true').pid
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    evict(db, root, 1, dead)
  } finally {
    vi.restoreAllMocks()
  }
  return dead
}

/** `stub`'s generator, noting at each fire whether its working folder already holds test/fizz. */
function looking(seen: boolean[]): ReturnType<typeof stub> {
  const fired = stub(1000, 'completed', true)
  return { ...fired, provider: { ...fired.provider, fire: (packet) => {
    seen.push(existsSync(join(packet.cwd, 'test/fizz')))
    return fired.provider.fire(packet)
  } } }
}

const deadSuite = (root: string, pid: number) => readFileSync(join(planDir(root, 1), `src.dead-${String(pid)}/test/fizz/FizzTest.sol`), 'utf8')

test('D1 D2 a dead lap\'s requeue fires on a fresh pre_fix clone', async () => {
  const { root, c1, c2 } = fixture()
  const dead = died(root, reaped(c1, c2))
  const seen: boolean[] = []
  expect((await generated(looking(seen), undefined, () => undefined, root)).outcome).toMatchObject({ outcome: 'pass' })
  expect(seen).toEqual([false])
  expect(git(srcDir(root, 1), ['rev-parse', 'HEAD']).trim()).toBe(c1)
  expect(deadSuite(root, dead)).toBe(HALF)
})

/** `checkedOut` with half a suite in src/ and `names` in the plan folder, a folder where the name ends in `/`. */
function left(...names: string[]): (root: string) => void {
  return (root) => {
    checkedOut(root)
    mkdirSync(join(srcDir(root, 1), 'test/fizz'), { recursive: true })
    writeFileSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'), HALF)
    for (const name of names) {
      if (name.endsWith('/')) mkdirSync(join(planDir(root, 1), name))
      else put(root, 1, name, '')
    }
  }
}

test('D3 D4 another step\'s or a kept dead lap leaves src/ alone', async () => {
  for (const ready of [left('step-2.dead-5.transcript.jsonl'), left('step-1.dead-5.transcript.jsonl', 'src.dead-5/')]) {
    const seen: boolean[] = []
    const { root, outcome } = await generated(looking(seen), undefined, ready)
    expect(outcome).toMatchObject({ outcome: 'pass' })
    expect(seen).toEqual([true])
    expect(existsSync(join(planDir(root, 1), 'src.dead-5/test'))).toBe(false)
  }
})

test('D4 a second dead lap moves src/ to its own pid', async () => {
  const { root, c1, c2 } = fixture()
  const first = died(root, reaped(c1, c2))
  const second = died(root)
  const seen: boolean[] = []
  expect((await generated(looking(seen), undefined, () => undefined, root)).outcome).toMatchObject({ outcome: 'pass' })
  expect(seen).toEqual([false])
  expect([deadSuite(root, first), deadSuite(root, second)]).toEqual([HALF, HALF])
})

test('D5 a dead lap\'s unfetchable pre_fix is refused, suite kept', async () => {
  const { root, c1, c2 } = fixture()
  const dead = died(root, reaped(c1, c2))
  const fired = stub(1000, 'completed', true)
  const { db, outcome } = await generated(fired, undefined, reaped('f'.repeat(40)), root)
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_checkout'], to: 0 })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
  expect(deadSuite(root, dead)).toBe(HALF)
})

/** A checked-out src/ depending on `file:dep`, with a root postinstall, and a lockfile that locks dep only when `synced`. */
function locked(synced: boolean): (root: string) => void {
  return (root) => {
    checkedOut(root)
    const dir = srcDir(root, 1)
    const pkg = { name: 'target', version: '1.0.0' }
    const dep = { 'node_modules/dep': { resolved: 'dep', link: true }, dep: { version: '1.0.0' } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, dependencies: { dep: 'file:dep' }, scripts: { postinstall: 'touch ran' } }))
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: synced
      ? { '': { ...pkg, hasInstallScript: true, dependencies: { dep: 'file:dep' } }, ...dep } : { '': { ...pkg, hasInstallScript: true } } }))
    mkdirSync(join(dir, 'dep'))
    writeFileSync(join(dir, 'dep/package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
  }
}

test('D1 a lockfile src/ is installed, scripts unrun, then fired', async () => {
  const fired = stub(1000, 'completed', true)
  const { root, outcome } = await generated(fired, undefined, locked(true))
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(fired.packets).toHaveLength(1)
  expect(existsSync(join(srcDir(root, 1), 'node_modules/dep'))).toBe(true)
  expect(existsSync(join(srcDir(root, 1), 'ran'))).toBe(false)
})

test('D2 a failed npm ci is refused unfired, with no run row', async () => {
  const fired = stub(1000, 'completed', true)
  const { db, outcome } = await generated(fired, undefined, locked(false))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.install'], note: expect.stringMatching(/^npm ci exited \d+: npm error/) as string })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
})

const YARN = '# yarn lockfile v1\n\n'

/** `locked`'s src/ with a yarn.lock in place of package-lock.json, locking dep only when `synced`. */
function yarned(synced: boolean): (root: string) => void {
  return (root) => {
    locked(synced)(root)
    rmSync(join(srcDir(root, 1), 'package-lock.json'))
    writeFileSync(join(srcDir(root, 1), 'yarn.lock'), `${YARN}${synced ? '"dep@file:dep":\n  version "1.0.0"\n' : ''}`)
  }
}

/** `npx yarn@1` would fetch yarn from the registry, so an `npx` first on PATH logs its words and cache, prints `out` and exits `code`. */
async function npxed<T>(out: string, code: number, run: () => Promise<T>): Promise<{ got: T; calls: string[] }> {
  const bin = mkdtempSync(join(tmpdir(), 'cf-npx-'))
  writeFileSync(join(bin, 'out'), out)
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$* $YARN_CACHE_FOLDER" >> '${bin}/log'\ncat '${bin}/out'\nexit ${String(code)}\n`)
  chmodSync(join(bin, 'npx'), 0o755)
  const path = process.env.PATH ?? ''
  process.env.PATH = `${bin}:${path}`
  const got = await run().finally(() => { process.env.PATH = path })
  return { got, calls: readFileSync(join(bin, 'log'), 'utf8').trimEnd().split('\n') }
}

const RESOLVING = 'yarn install v1.22.22\n[1/4] Resolving packages...\n'

test('D1 yarn.lock src/ runs yarn@1 frozen, scripts unrun, fired', async () => {
  const fired = stub(1000, 'completed', true)
  let before = ''
  const kept = (root: string) => {
    yarned(true)(root)
    before = readFileSync(join(srcDir(root, 1), 'package.json'), 'utf8')
  }
  const host = process.env.YARN_CACHE_FOLDER
  const caches = yarnCaches()
  process.env.YARN_CACHE_FOLDER = mkdtempSync(join(tmpdir(), 'cf-shared-'))
  try {
    const { got, calls } = await npxed(RESOLVING, 0, () => generated(fired, undefined, kept))
    expect(got.outcome).toMatchObject({ outcome: 'pass' })
    expect(fired.packets).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.startsWith(`yarn@1 install --frozen-lockfile --ignore-scripts ${join(tmpdir(), 'cf-yarn-')}`)).toBe(true)
    expect(readFileSync(join(srcDir(got.root, 1), 'package.json'), 'utf8')).toBe(before)
  } finally {
    if (host === undefined) delete process.env.YARN_CACHE_FOLDER
    else process.env.YARN_CACHE_FOLDER = host
  }
  expect(yarnCaches()).toBe(caches)
})

const yarnCaches = () => readdirSync(tmpdir()).filter((f) => f.startsWith('cf-yarn-')).length

test('D2 a failed yarn install is refused unfired, no run row', async () => {
  const fired = stub(1000, 'completed', true)
  const caches = yarnCaches()
  const stale = `${RESOLVING}error Your lockfile needs to be updated, but yarn was run with \`--frozen-lockfile\`.\n`
  const { got: { db, outcome } } = await npxed(stale, 1, () => generated(fired, undefined, yarned(false)))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.install'], note: expect.stringMatching(/^npx yarn@1 exited \d+/) as string })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
  expect(yarnCaches()).toBe(caches)
})

test('D1 a failed yarn git step keeps its block in the note', async () => {
  const block = 'error Command failed.\nExit code: 128\nCommand: git\nArguments: ls-remote --tags --heads file:///tmp/cf-dep-x'
  const out = `${RESOLVING}${block}\nDirectory: /tmp/src\nOutput:\nfatal: '/tmp/cf-dep-x' does not appear to be a git repository\n`
  const fired = stub(1000, 'completed', true)
  const { got: { db, outcome } } = await npxed(out, 1, () => generated(fired, undefined, yarned(false)))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.install'], note: `npx yarn@1 exited 1: ${block}` })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
})

const PNPM = "lockfileVersion: '9.0'\n"

test('D2 a failed pnpm install is refused unfired, no run row', async () => {
  const pnpmed = (root: string) => {
    locked(false)(root)
    rmSync(join(srcDir(root, 1), 'package-lock.json'))
    writeFileSync(join(srcDir(root, 1), 'pnpm-lock.yaml'), PNPM)
  }
  const fired = stub(1000, 'completed', true)
  const { db, outcome } = await generated(fired, undefined, pnpmed)
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.install'], note: expect.stringMatching(/^pnpm install exited \d+/) as string })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
})

test('D3 with both lockfiles npm ci installs and yarn does not', async () => {
  const both = (synced: boolean) => (root: string) => {
    locked(synced)(root)
    writeFileSync(join(srcDir(root, 1), 'yarn.lock'), YARN)
    writeFileSync(join(srcDir(root, 1), 'pnpm-lock.yaml'), PNPM)
  }
  const fired = stub(1000, 'completed', true)
  const { root, outcome } = await generated(fired, undefined, both(true))
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(existsSync(join(srcDir(root, 1), 'node_modules/dep'))).toBe(true)
  const failed = await generated(stub(1000, 'completed', true), undefined, both(false))
  expect(failed.outcome).toMatchObject({ outcome: 'refuse', note: expect.stringMatching(/^npm ci exited/) as string })
})

test('D5 tick on an empty src/ sends the plan back to step 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  staffedIn(root)
  emptied(root)
  target(root, { generator: 'fizz' })
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench', 1)
  await tick(db, root, stub(1000, 'completed', true).provider, OPENS)
  expect(planById(db, 1).step).toBe(0)
  expect(planById(db, 1).state).not.toBe('blocked_on_ceo')
})

test('tick on a degraded fizz suite refuses back to step 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  staffedIn(root)
  checkedOut(root)
  target(root, { generator: 'fizz' })
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench', 1)
  await tick(db, root, stub(1000, 'completed', true, null, false, suite(1)).provider, OPENS)
  expect(refusalRows(db, 1)).toMatchObject([{ step: 1, span: 'bench.few_properties' }])
  expect(planById(db, 1).step).toBe(0)
  expect(maybe(root, 1, 'generate.json')).toBeNull()
  expect(maybe(root, 1, 'score.json')).toBeNull()
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
  expect(await tick(db, root, stub(1000, 'completed', true).provider, OPENS)).toMatchObject([{ plan: 1, step: 1 }])
  expect(planById(db, 1).lane).toBeNull()
})

test('D3 a run at the ceiling is refused', async () => {
  for (const [fired, tokens] of [[stub(CEILING + 5, 'stopped', true, 'ruling:run.token_wall'), CEILING + 5], [stub(CEILING, 'completed', true), CEILING]] as const) {
    const { root, db, outcome } = await generated(fired)
    expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.ceiling'], note: expect.stringContaining(String(tokens)) as string })
    expect(maybe(root, 1, 'generate.json')).toBe(null)
    expect(runRows(db)).toMatchObject([{ seat: 'fizz_generator', staffed: 'fizz_generator' }])
  }
})

test('D2 generate.json has x_ray 1 when x-ray.md was written', async () => {
  const { root } = await generated(stub(1000, 'completed', true, null, true))
  expect(JSON.parse(get(root, 1, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: 1000, seconds: 1, x_ray: 1, agents: 8, properties: 3 })
})

test('D4 generate.json counts the sub-agents the run spawned', async () => {
  const { root, db } = await generated(stub(1000, 'completed', true))
  expect(JSON.parse(get(root, 1, 'generate.json'))).toMatchObject({ agents: 8, properties: 3 })
  expect(runRows(db)).toMatchObject([{ transcript_path: join(planDir(root, 1), 'run-1.transcript.jsonl') }])
})

test('1994 D4 generate is offline and logs each refused command', async () => {
  const fired = stub(1000, 'completed', true)
  const command = "bash -c 'curl https://github.com'"
  const { db } = await generated({ ...fired, provider: { ...fired.provider, fire: async (packet) => ({ ...await fired.provider.fire(packet), offline: [command] }) } })
  expect(fired.packets).toMatchObject([{ offline: true }])
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'run.offline'))
    .toEqual([{ plan: 1, kind: 'run.offline', actor: 'fizz_generator', outcome: 'refuse', message: command, pointer: null, run: runRows(db)[0]?.id }])
})

test('D4 a completed run with no suite is refused', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', false))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_suite'], note: 'fizz_generator (completed, 1000 tokens) wrote no .sol under test/fizz outside fizz_data' })
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

test('D1 a bare-template suite is refused', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', ['test/fizz/Properties.sol'], null, false,
    'contract Properties {\n  function setUp() public {}\n}\n'))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_properties'], note: expect.stringContaining('test/fizz/Properties.sol') as string })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('D1 a commented-out property is refused', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', ['test/fizz/Properties.sol'], null, false,
    'contract Properties {\n  // function invariant_x() public {}\n  /* function property_y() public {} */\n}\n'))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_properties'] })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('D1 a property outside Properties.sol is refused', async () => {
  const empty = (root: string) => {
    checkedOut(root)
    mkdirSync(join(srcDir(root, 1), 'test/fizz'), { recursive: true })
    writeFileSync(join(srcDir(root, 1), 'test/fizz/Properties.sol'), '')
  }
  const { root, outcome } = await generated(stub(1000, 'completed', ['test/fizz/FuzzTester.sol'], null, false,
    'contract FuzzTester {\n  function echidna_x() public {}\n}\n'), undefined, empty)
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_properties'], note: expect.stringMatching(/in test\/fizz\/Properties\.sol$/) as string })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

test('properties in PropertiesBatch<N>.sol count too', async () => {
  const { outcome } = await generated(stub(1000, 'completed', ['test/fizz/Properties.sol', 'test/fizz/PropertiesBatch1.sol', 'test/fizz/PropertiesBatch12.sol', 'test/fizz/Other.sol'], null, false, suite(1)))
  expect(outcome).toMatchObject({ outcome: 'pass', note: expect.stringMatching(/, 3 properties$/) as string })
})

test('a fizz suite under 3 properties or 8 agents goes to step 0', async () => {
  for (const [properties, agents, why] of [[1, 8, 'few_properties'], [2, 8, 'few_properties'], [3, 5, 'reduced_generate'], [1, 5, 'reduced_generate']] as const) {
    const { root, outcome } = await generated(stub(1000, 'completed', ['test/fizz/Properties.sol'], null, false, suite(properties), agents))
    expect(outcome).toEqual({ outcome: 'refuse', spans: [`bench.${why}`], to: 0,
      note: `fizz_generator (completed, 1000 tokens) spawned ${String(agents)} sub-agents and wrote ${String(properties)} properties` })
    expect(maybe(root, 1, 'generate.json')).toBeNull()
  }
  const { outcome } = await generated(stub(1000, 'completed', ['test/fizz/Properties.sol']))
  expect(outcome).toMatchObject({ outcome: 'pass', note: expect.stringMatching(/, 3 properties$/) as string })
})

test('a house_generator suite is not gated on agents', async () => {
  const { root, outcome } = await generated(stub(1000, 'completed', true, null, false, BODY, 0), { generator: 'house_generator' })
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(root, 1, 'generate.json'))).toMatchObject({ agents: 0, properties: 3 })
  const few = await generated(stub(1000, 'completed', true, null, false, suite(1), 0), { generator: 'house_generator' })
  expect(few.outcome).toEqual({ outcome: 'refuse', spans: ['bench.few_properties'],
    note: 'house_generator (completed, 1000 tokens) wrote 1 properties under test/fizz, fewer than the 3 score counts' })
})

test('D4 a generate pass with 0 properties is seen', () => {
  const db = fresh(schema)
  logged(db, { plan: null, kind: 'generate', actor: 'generate', outcome: 'pass',
    message: 'generate.json written: fizz_generator completed, 1000 tokens, 0 properties', pointer: null, run: null }, AT)
  expect(drift(db, mechanisms(REPO).filter((e) => e.name === 'bench_no_properties'), OPENS))
    .toMatchObject([{ name: 'bench_no_properties', state: 'seen' }])
})

test('D6 a score pass on a live degraded row is seen', () => {
  const degraded = (not_powered: Score['not_powered'], superseded = false) => {
    const db = fresh(schema)
    queued(db, 'bench', 2)
    record(db, { plan: 1, ...KEYS, ...SCORE, x_ray: null, not_powered })
    if (superseded) supersede(db, 1)
    logged(db, { plan: 1, kind: 'score', actor: 'score', outcome: 'pass', message: 'score.json written', pointer: null, run: null }, AT)
    return drift(db, mechanisms(REPO).filter((e) => e.name === 'bench_degraded'), OPENS)
  }
  for (const reason of ['few_properties', 'reduced_generate'] as const) expect(degraded(reason)).toMatchObject([{ name: 'bench_degraded', state: 'seen' }])
  expect(degraded('pre_fix_calls')).toEqual([])
  expect(degraded('few_properties', true)).toEqual([])
})

test('D4 a score needs_coo is seen unless a park precedes it', () => {
  const held = (parked: boolean) => {
    const db = fresh(schema)
    queued(db, 'bench', 2)
    if (parked) logged(db, { plan: 1, kind: 'park', actor: 'coo', outcome: 'pass', message: 'parked', pointer: null, run: null }, AT)
    logged(db, { plan: 1, kind: 'score', actor: 'score', outcome: 'needs_coo', message: '', pointer: 'step-2', run: null }, AT)
    return drift(db, mechanisms(REPO).filter((e) => e.name === 'bench_score_hold'), OPENS)
  }
  expect(held(true)).toEqual([])
  expect(held(false)).toMatchObject([{ name: 'bench_score_hold', state: 'seen' }])
})

test('D5 a stop under the ceiling is refused on its reason', async () => {
  const why = 'ruling:seat.write_paths refuses a write to src/vault.sol'
  const { root, outcome } = await generated(stub(1000, 'stopped', true, why))
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: [why] })
  expect(maybe(root, 1, 'generate.json')).toBeNull()
})

const COST_WALLED = 'ruling:run.cost_wall stopped the run at $40.10, past the $40 wall'

test('the generate packet carries the cost wall from settings', async () => {
  const fired = stub(1000, 'completed', true)
  await generated(fired)
  expect(fired.packets).toMatchObject([{ cost_wall: { usd: 60, input: 4, cache_write: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 } }])
})

test('the cost wall is read from settings, refused without it', async () => {
  const db = fresh(schema)
  const prices = { input: 4, cache_write: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 }
  expect(costWall(db, 'claude-agent-sdk', 'claude-opus-5-5')).toEqual({ usd: 60, ...prices })
  set(db, 'bench.cost_wall_usd', '75', 'ceo', '2026-11-07')
  expect(costWall(db, 'claude-agent-sdk', 'claude-opus-5-5')).toEqual({ usd: 75, ...prices })
  db.exec("DELETE FROM settings WHERE key = 'bench.cost_wall_usd'")
  expect(costWall(db, 'claude-agent-sdk', 'claude-opus-5-5')).toEqual({ outcome: 'refuse', spans: ['bench.no_cost_wall'],
    note: 'no settings row bench.cost_wall_usd' })
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  staffedIn(root)
  checkedOut(root)
  target(root, { generator: 'fizz' })
  queued(db, 'bench')
  const fired = stub(1000, 'completed', true)
  expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), fired.provider)).toMatchObject({ outcome: 'refuse', spans: ['bench.no_cost_wall'] })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
})

test('1617b D2 a cost-walled generate passes with its wall', async () => {
  const { root, outcome } = await generated(stub(1000, 'stopped', false, COST_WALLED))
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: `generate.json written: ${COST_WALLED}` })
  expect(JSON.parse(get(root, 1, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: 1000, seconds: 1, wall: COST_WALLED, x_ray: 0, agents: 8 })
})

test('1617b D3 a cost-walled generate scores wall, no pair', () => {
  const { root, db } = sided(8, 505660, 505660)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5, agents: 8, wall: COST_WALLED }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass', note: expect.stringContaining('run.cost_wall') as string })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/results/euler-earn-m01/euler-earn-m01.jsonl'))).toBe(false)
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', catches: 0, false_positives: 0, untested: null, tokens: 1234,
    seconds: 56.5, x_ray: null, pre_fix_calls: null, fix_calls: null, not_powered: 'wall', gross_usd: 0, net_usd: 0 }])
})

const REPEAT_READ = 'ruling:run.repeat_read stopped the run after 61 reads of /tmp/x.ts'

test('1839 D4 a repeat-read generate passes with its wall', async () => {
  const { root, outcome } = await generated(stub(1000, 'stopped', false, REPEAT_READ))
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: `generate.json written: ${REPEAT_READ}` })
  expect(JSON.parse(get(root, 1, 'generate.json'))).toMatchObject({ wall: REPEAT_READ })
})

test('1839 D5 a repeat-read generate scores wall', () => {
  const { root, db } = sided(8, 505660, 505660)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5, agents: 8, wall: REPEAT_READ }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass', note: expect.stringContaining('run.repeat_read') as string })
  expect(scores(db)).toMatchObject([{ plan: 1, not_powered: 'wall' }])
})

test('1617b D4 an unpriced model is refused unfired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  staffedIn(root)
  checkedOut(root)
  target(root, { generator: 'fizz' })
  const db = fresh(schema)
  db.exec('DELETE FROM prices')
  queued(db, 'bench')
  const fired = stub(1000, 'completed', true)
  expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), fired.provider)).toMatchObject({ outcome: 'refuse', spans: ['bench.unpriced'] })
  expect(fired.packets).toEqual([])
  expect(runRows(db)).toEqual([])
})

test('1617b D5 a cost-walled generate event is seen', () => {
  const db = fresh(schema)
  logged(db, { plan: null, kind: 'generate', actor: 'generate', outcome: 'pass', message: `generate.json written: ${COST_WALLED}`, pointer: null, run: null }, AT)
  expect(drift(db, mechanisms(REPO).filter((e) => e.name === 'bench_cost_wall'), OPENS)).toMatchObject([{ name: 'bench_cost_wall', state: 'seen' }])
})

test('D6 no generator is refused, an unstaffed one needs the ceo', async () => {
  expect((await generated(stub(0, 'completed', false), {})).outcome).toMatchObject({ outcome: 'refuse', spans: ['target.yml'] })
  expect((await generated(stub(0, 'completed', false), { generator: 'nobody' })).outcome).toMatchObject({ outcome: 'needs_ceo', spans: ['staffing'] })
})

const PAIRS = [{ property: 'p1', pre_fix: 'fail', fix: 'pass' }, { property: 'p2', pre_fix: 'fail', fix: 'pass' }, { property: 'p3', pre_fix: 'pass', fix: 'fail' },
  { property: 'p4', pre_fix: 'pass', fix: 'pass' }]

const KILLS = [{ property: 'p1', kills: 3, untested: false }, { property: 'p4', kills: 0, untested: true }]

const UPSTREAM = 'repo: euler-xyz/euler-earn\nfiles:\n  - src/EulerEarn.sol\n\n'

const REFRESHED = 'repo: euler-xyz/euler-earn\nfiles:\n  - src/EulerEarn.sol\ntarget: euler-earn-m01\ngenerator: fizz\n'

/** A stub fuzz-bench script that writes `rows` to `results/<suite>/<suite><suffix>`, making the folder first when `makes`. */
function writes(suffix: string, rows: object[], makes = true): string {
  const body = JSON.stringify(rows.map((r) => JSON.stringify(r)).join('\n'))
  const made = makes ? `os.makedirs(f'results/{name}', exist_ok=True)\n` : ''
  return `import os, sys\nname = os.path.basename(sys.argv[2])\n${made}open(f'results/{name}/{name}${suffix}', 'w').write(${body})\n`
}

const FILES = '[src/vault.sol]'

/** A bench plan at score with its suite written, and `remotes/caliperforge/fuzz-bench` whose run_pair.py is `pair`. */
function scoring(pair = writes('.jsonl', PAIRS), keys: Record<string, string> = { target: 'euler-earn-m01', generator: 'fizz', files: FILES }) {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  const dir = join(root, 'remotes/caliperforge/fuzz-bench')
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  commit(dir, 'bench/null_check.py', writes('.nullcheck.jsonl', KILLS), 'null check')
  commit(dir, 'targets/euler-earn-m01.yml', UPSTREAM, 'target')
  const sha = commit(dir, 'bench/run_pair.py', pair, 'run pair')
  mkdirSync(join(root, '.cf'))
  writeFileSync(join(root, '.cf/git-base'), join(root, 'remotes'))
  mkdirSync(join(srcDir(root, 1), 'test/fizz'), { recursive: true })
  writeFileSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'), BODY)
  checkedOut(root)
  target(root, keys)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5 }))
  const db = fresh(schema)
  queued(db, 'bench', 2)
  return { root, db, sha }
}

const SCORE = { catches: 2, false_positives: 1, untested: null, tokens: 1234, seconds: 56.5, pre_fix_calls: null, fix_calls: null,
  not_powered: 'reduced_generate', gross_usd: 0, net_usd: 0 }

/** The broken, flaky, seeds and union score.json carries for PAIRS on each of the two seeds. */
const SEEDED = { broken: 0, flaky: 0, seeds: [1, 2].map((seed) => ({ seed, catch: 2, false_positive: 1, broken: 0, silent: 1, not_run: 0, calls: { pre_fix: null, fix: null }, seconds: expect.any(Number) as number })),
  union: { catch: 2, false_positive: 1, broken: 0, flaky: 0, silent: 1, not_run: 0 } }

const NULLCHECK = 'fuzz-bench/results/euler-earn-m01/euler-earn-m01.nullcheck.jsonl'

test('score D1 kernel scores the suite at the fuzz-bench HEAD', () => {
  const { root, db, sha } = scoring()
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(existsSync(join(planDir(root, 1), NULLCHECK))).toBe(false)
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', ...SCORE, x_ray: null }])
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/FizzTest.sol'))).toBe(true)
  expect(existsSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'))).toBe(true)
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'))).toBe(false)
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/root'))).toBe(false)
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...SCORE, x_ray: null, ...SEEDED })
})

test('D1 scored rewrites target.yml from fuzz-bench HEAD', () => {
  const { root, db } = scoring()
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(get(root, 1, 'target.yml')).toBe(REFRESHED)
  expect(readFileSync(join(planDir(root, 1), 'fuzz-bench/targets/euler-earn-m01.yml'), 'utf8')).toBe(UPSTREAM)
})

test('D3 no upstream targets yml is refused, copy kept', () => {
  const { root, db } = scoring()
  const dir = join(root, 'remotes/caliperforge/fuzz-bench')
  git(dir, ['rm', '-q', 'targets/euler-earn-m01.yml'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'no target'])
  const before = get(root, 1, 'target.yml')
  expect(scored(db, root, planById(db, 1)))
    .toEqual({ outcome: 'refuse', spans: ['target.yml'], note: 'fuzz-bench has no targets/euler-earn-m01.yml' })
  expect(get(root, 1, 'target.yml')).toBe(before)
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/results/euler-earn-m01/euler-earn-m01.jsonl'))).toBe(false)
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
})

test('D1 D4 a root medusa.json is copied with its paths moved', () => {
  const { root, db } = scoring(`import os, sys\nos.path.exists(os.path.join(sys.argv[2], 'medusa.json')) or sys.exit('no medusa.json')\n${
    writes('.jsonl', PAIRS)}`)
  const config = JSON.stringify({ fuzzing: { corpusDirectory: 'test/fizz/fizz_data/corpus_medusa', targetContracts: ['FuzzTester'] },
    compilation: { platform: 'crytic-compile', platformConfig: { target: '.' } } })
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), config)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', ...SCORE, x_ray: null }])
  expect(JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))).toEqual({
    fuzzing: { corpusDirectory: 'fizz_data/corpus_medusa', targetContracts: ['FuzzTester'], timeout: 7200, workers: 4, shrinkLimit: 500 },
    compilation: { platform: 'crytic-compile', platformConfig: { target: '../..' } }, slither: { useSlither: false } })
  expect(readFileSync(join(srcDir(root, 1), 'medusa.json'), 'utf8')).toBe(config)
  expect(existsSync(join(srcDir(root, 1), 'test/fizz/medusa.json'))).toBe(false)
})

/** The medusa.json `scored` installs in the suite for a root medusa.json of `config`, with empty `files` in the checkout. */
function installed(config: string, ...files: string[]): unknown {
  const { root, db } = scoring()
  for (const file of files) writeFileSync(join(srcDir(root, 1), file), '')
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), config)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(readFileSync(join(srcDir(root, 1), 'medusa.json'), 'utf8')).toBe(config)
  return JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))
}

test('a standalone medusa.json is the scored one but for workers', () => {
  const { root, db } = scoring()
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { timeout: 0, workers: 10, shrinkLimit: 5000,
    corpusDirectory: 'test/fizz/fizz_data/corpus_medusa' }, slither: { useSlither: true } }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const suite = JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8')) as { fuzzing: object }
  expect(suite).toEqual({ fuzzing: { timeout: 7200, workers: 4, shrinkLimit: 500, corpusDirectory: 'fizz_data/corpus_medusa' }, slither: { useSlither: false } })
  const bin = mkdtempSync(join(tmpdir(), 'cf-forge-'))
  writeFileSync(join(bin, 'forge'), '#!/bin/sh\nmkdir -p out/build-info\n', { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
  const [out, ignored] = [join(root, 'measure.json'), { ...suite, compilation: { platformConfig: { args: ['--foundry-ignore-compile'] } } }]
  expect(medusaFile(db, srcDir(root, 1), 'test/fizz', 6, out)).toEqual({ clamped: [], compile: expect.any(Number) as number })
  expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ ...ignored, fuzzing: { ...suite.fuzzing, workers: 6 } })
  expect(medusaFile(db, srcDir(root, 1), 'test/fizz', 10, out)).toEqual({ clamped: [], compile: 0 })
  expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ ...ignored, fuzzing: { ...suite.fuzzing, workers: 10 } })
})

test('D1 D2 the copy turns slither off and caps shrinking', () => {
  expect(installed(JSON.stringify({ fuzzing: { timeout: 0, workers: 10, testLimit: 0, shrinkLimit: 5000, testing: { stopOnFailedTest: false } },
    slither: { useSlither: true, cachePath: 'test/fizz/fizz_data/slither_results.json' } }))).toEqual({
    fuzzing: { timeout: 7200, workers: 4, testLimit: 0, shrinkLimit: 500, testing: { stopOnFailedTest: false } },
    slither: { useSlither: false, cachePath: 'fizz_data/slither_results.json' } })
})

/** A root medusa.json for crytic-compile with platformConfig `args`. */
function compiled(args: string[]): string {
  return JSON.stringify({ compilation: { platform: 'crytic-compile', platformConfig: { target: '.', args } } })
}

test('D1 a foundry.toml forces the foundry framework', () => {
  expect(installed(compiled(['--foundry-compile-all']), 'foundry.toml', 'hardhat.config.ts')).toEqual({ compilation: { platform: 'crytic-compile',
    platformConfig: { target: '../..', args: ['--foundry-compile-all', '--compile-force-framework', 'foundry'] } }, slither: { useSlither: false } })
})

test('D2 no foundry.toml keeps the args as written', () => {
  expect(installed(compiled(['--foundry-compile-all']))).toEqual({ compilation: { platform: 'crytic-compile',
    platformConfig: { target: '../..', args: ['--foundry-compile-all'] } }, slither: { useSlither: false } })
})

test('D3 a forced framework already in args is kept', () => {
  expect(installed(compiled(['--compile-force-framework', 'hardhat']), 'foundry.toml')).toEqual({ compilation: { platform: 'crytic-compile',
    platformConfig: { target: '../..', args: ['--compile-force-framework', 'hardhat'] } }, slither: { useSlither: false } })
})

test('D1 D2 D3 --foundry-ignore-compile is --foundry-compile-all', () => {
  const forced = installed(compiled(['--foundry-ignore-compile']), 'foundry.toml')
  const kept = installed(compiled(['--foundry-ignore-compile']))
  expect(forced).toEqual({ compilation: { platform: 'crytic-compile', platformConfig: { target: '../..',
    args: ['--foundry-compile-all', '--compile-force-framework', 'foundry'] } }, slither: { useSlither: false } })
  expect(kept).toEqual({ compilation: { platform: 'crytic-compile',
    platformConfig: { target: '../..', args: ['--foundry-compile-all'] } }, slither: { useSlither: false } })
  for (const copy of [forced, kept]) expect(JSON.stringify(copy)).not.toContain('--foundry-ignore-compile')
})

test('--ignore-compile is dropped beside a custom out', () => {
  const { root, db } = scoring()
  writeFileSync(join(srcDir(root, 1), 'foundry.toml'), '[profile.default]\nout = "out-fuzz"\n')
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), compiled(['--foundry-compile-all', '--ignore-compile']))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const copy: unknown = JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))
  expect(copy).toMatchObject({ compilation: { platformConfig: { args: ['--foundry-compile-all', '--compile-force-framework', 'foundry'] } } })
})

const TOML = '[profile.default]\nsrc = "src"\n'

const FORGE = 'contract Test {}\n'

/** The `root/` folder `scored` leaves in the suite once `ready` has shaped the scored src/. */
function rootOf(ready: (src: string) => void): { src: string; carried: string } {
  const { root, db } = scoring()
  ready(srcDir(root, 1))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  return { src: srcDir(root, 1), carried: join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/root') }
}

function forged(src: string): void {
  writeFileSync(join(src, 'hardhat.config.ts'), '')
  writeFileSync(join(src, 'foundry.toml'), TOML)
  mkdirSync(join(src, 'lib/forge-std/src'), { recursive: true })
  writeFileSync(join(src, 'lib/forge-std/src/Test.sol'), FORGE)
}

test('D1 an untracked foundry.toml and forge-std reach root', () => {
  const { src, carried } = rootOf(forged)
  expect(readFileSync(join(carried, 'foundry.toml'), 'utf8')).toBe(TOML)
  expect(readFileSync(join(carried, 'lib/forge-std/src/Test.sol'), 'utf8')).toBe(FORGE)
  expect(readFileSync(join(src, 'foundry.toml'), 'utf8')).toBe(TOML)
  expect(readFileSync(join(src, 'lib/forge-std/src/Test.sol'), 'utf8')).toBe(FORGE)
})

test('D2 a tracked foundry.toml is not carried', () => {
  expect(existsSync(rootOf((src) => { commit(src, 'foundry.toml', TOML, 'foundry') }).carried)).toBe(false)
})

test('D4 an untracked foundry.toml alone is carried alone', () => {
  const { carried } = rootOf((src) => { writeFileSync(join(src, 'foundry.toml'), TOML) })
  expect(readFileSync(join(carried, 'foundry.toml'), 'utf8')).toBe(TOML)
  expect(existsSync(join(carried, 'lib'))).toBe(false)
})

const FUZZ = `${TOML}[profile.fuzz]\nout = "out-fuzz"\n`

/** The installed args and score.json for a root medusa.json passing `--foundry-out-directory out-fuzz`, once `ready` has shaped src/. */
function outFuzz(ready: (src: string) => void, pair?: string): { args: unknown; score: unknown } {
  const { root, db } = scoring(pair)
  ready(srcDir(root, 1))
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), compiled(['--foundry-out-directory', 'out-fuzz']))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const config = JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8')) as
    { compilation: { platformConfig: { args: unknown } } }
  return { args: config.compilation.platformConfig.args, score: JSON.parse(get(root, 1, 'score.json')) }
}

test('D1 an out dir HEAD foundry.toml lacks is dropped', () => {
  const { args, score } = outFuzz((src) => {
    commit(src, 'foundry.toml', TOML, 'foundry')
    writeFileSync(join(src, 'foundry.toml'), FUZZ)
  }, `import os, sys\n'--foundry-out-directory' in open(os.path.join(sys.argv[2], 'medusa.json')).read() and sys.exit('out-fuzz/build-info is not a directory')\n${
    writes('.jsonl', PAIRS)}`)
  expect(args).toEqual(['--compile-force-framework', 'foundry'])
  expect(score).toMatchObject({ foundry_out_dropped: 'out-fuzz' })
})

test('D2 an out dir the carried foundry.toml sets is kept', () => {
  const { args, score } = outFuzz((src) => { writeFileSync(join(src, 'foundry.toml'), FUZZ) })
  expect(args).toEqual(['--foundry-out-directory', 'out-fuzz', '--compile-force-framework', 'foundry'])
  expect(score).not.toHaveProperty('foundry_out_dropped')
})

const FORGED = ['test/fizz/FizzTest.sol', 'foundry.toml', 'lib/forge-std/src/Test.sol']

const CARRIED = 'fuzz-bench/suites/fizz/euler-earn-m01/root'

/** A Hardhat-only checkout at score whose generate pass `fired` ran, with foundry.toml committed when `tracked`, scored by `pair`. */
async function hardhat(fired: ReturnType<typeof stub>, pair?: string, tracked = false) {
  const { root } = scoring(pair)
  return generated(fired, { target: 'euler-earn-m01', generator: 'fizz', files: FILES }, (at) => {
    if (tracked) commit(srcDir(at, 1), 'foundry.toml', TOML, 'foundry')
    put(at, 1, 'checkout.json', JSON.stringify({ pre_fix: commit(srcDir(at, 1), 'hardhat.config.ts', '', 'hardhat') }))
  }, root)
}

test('D1 generate writes foundry.toml and forge-std to root', async () => {
  const { root, outcome } = await hardhat(stub(1000, 'completed', FORGED))
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(readFileSync(join(planDir(root, 1), CARRIED, 'foundry.toml'), 'utf8')).toBe(BODY)
  expect(readFileSync(join(planDir(root, 1), CARRIED, 'lib/forge-std/src/Test.sol'), 'utf8')).toBe(BODY)
})

test('D2 scored keeps the generate root without src foundry.toml', async () => {
  const { root, db } = await hardhat(stub(1000, 'completed', FORGED))
  rmSync(join(srcDir(root, 1), 'foundry.toml'))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(readFileSync(join(planDir(root, 1), CARRIED, 'foundry.toml'), 'utf8')).toBe(BODY)
})

test('D3 a rescore after reap still finds root/foundry.toml', async () => {
  const pair = `import os, sys\nos.path.exists(os.path.join(sys.argv[2], 'root/foundry.toml')) or sys.exit('forge build failed')\n${
    writes('.jsonl', PAIRS)}`
  const { root, db } = await hardhat(stub(1000, 'completed', FORGED), pair)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  end(db, 1, 'done')
  expect(reap(root, [1])).toEqual([1])
  expect(rescore(db, root, 1, 'coo', 'forge build failed')).toBe(1)
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toHaveLength(2)
  expect(readFileSync(join(planDir(root, 1), CARRIED, 'foundry.toml'), 'utf8')).toBe(BODY)
})

test('D4 a tracked foundry.toml or no property writes no root', async () => {
  const tracked = await hardhat(stub(1000, 'completed', true), undefined, true)
  expect(tracked.outcome).toMatchObject({ outcome: 'pass' })
  expect(existsSync(join(planDir(tracked.root, 1), CARRIED))).toBe(false)
  const unproven = await hardhat(stub(1000, 'completed', FORGED, null, false, 'contract FizzTest {}\n'))
  expect(unproven.outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.no_properties'] })
  expect(existsSync(join(planDir(unproven.root, 1), CARRIED))).toBe(false)
})

test('a cost-walled generate archives its suite as partial', async () => {
  const { root, outcome } = await generated(stub(1000, 'stopped', FORGED, COST_WALLED), { generator: 'fizz', target: 'euler-earn-m01' })
  expect(outcome).toEqual({ outcome: 'pass', spans: [], note: `generate.json written: ${COST_WALLED}` })
  expect(JSON.parse(get(root, 1, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: 1000, seconds: 1, wall: COST_WALLED, partial: COST_WALLED, x_ray: 0, agents: 8 })
  expect(readFileSync(join(planDir(root, 1), CARRIED, '../FizzTest.sol'), 'utf8')).toBe(BODY)
  expect(readFileSync(join(planDir(root, 1), CARRIED, 'foundry.toml'), 'utf8')).toBe(BODY)
})

test('a walled, reaped plan rescores its partial suite', () => {
  const { root, db } = scoring()
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5, agents: 8, wall: COST_WALLED, partial: COST_WALLED }))
  cpSync(join(srcDir(root, 1), 'test/fizz'), join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01'), { recursive: true })
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass', note: expect.stringContaining('unscored') as string })
  end(db, 1, 'done')
  expect(reap(root, [1])).toEqual([1])
  expect(rescore(db, root, 1, 'coo', 'partial suite')).toBe(1)
  expect(JSON.parse(get(root, 1, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: 1234, seconds: 56.5, agents: 8, partial: COST_WALLED })
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ catches: 2, false_positives: 1, not_powered: 'wall', partial: COST_WALLED })
  expect(scores(db)[1]).toMatchObject({ catches: 2, false_positives: 1, not_powered: 'wall' })
  expect(runRows(db).filter((r) => r.step === 1)).toEqual([])
})

test('D3 a set timeout and workers at most 4 are kept', () => {
  expect(installed(JSON.stringify({ fuzzing: { timeout: 600, workers: 2 } }))).toEqual({
    fuzzing: { timeout: 600, workers: 2, shrinkLimit: 500 }, slither: { useSlither: false } })
})

test('the score timeout is read from settings, refused without it', () => {
  const tuned = scoring()
  set(tuned.db, 'bench.score_seconds', '5400', 'ceo', AT)
  writeFileSync(join(srcDir(tuned.root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { workers: 2 } }))
  expect(scored(tuned.db, tuned.root, planById(tuned.db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(readFileSync(join(planDir(tuned.root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8')))
    .toMatchObject({ fuzzing: { timeout: 5400 } })
  const { root, db } = scoring()
  dropSettings(db, 'bench.score_seconds')
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { workers: 2 } }))
  expect(scored(db, root, planById(db, 1)))
    .toEqual({ outcome: 'refuse', spans: ['bench.no_score_seconds'], note: 'no settings row bench.score_seconds' })
  expect(scores(db)).toEqual([])
})

test('D1 D2 D3 a balance above 1e24 wei is clamped in the copy', () => {
  const { root, db } = scoring()
  const balances = ['0xffffffffffffffffffffffffffffffffffffffffffffffff', '0x21e19e0c9bab2400000', 'lots']
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { timeout: 600, workers: 2, targetContractsBalances: balances } }))
  const done = scored(db, root, planById(db, 1))
  expect(done).toMatchObject({ outcome: 'pass' })
  expect(done.note).toContain('0xffffffffffffffffffffffffffffffffffffffffffffffff')
  expect(done.note).not.toContain('0x21e19e0c9bab2400000')
  expect(JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))).toEqual({
    fuzzing: { timeout: 600, workers: 2, targetContractsBalances: ['0xd3c21bcecceda1000000', '0x21e19e0c9bab2400000', 'lots'],
      shrinkLimit: 500 }, slither: { useSlither: false } })
})

test('rescore D5 a suite medusa.json is clamped, paths kept', () => {
  const { root, db } = scoring()
  const balances = ['0xffffffffffffffffffffffffffffffffffffffffffffffff']
  writeFileSync(join(srcDir(root, 1), 'test/fizz/medusa.json'), JSON.stringify({ fuzzing: { corpusDirectory: 'fizz_data/corpus_medusa',
    targetContractsBalances: balances }, compilation: { platformConfig: { target: '../..' } } }))
  expect(scored(db, root, planById(db, 1)).note).toContain(balances[0])
  expect(JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))).toEqual({
    fuzzing: { corpusDirectory: 'fizz_data/corpus_medusa', targetContractsBalances: ['0xd3c21bcecceda1000000'], timeout: 7200, workers: 4,
      shrinkLimit: 500 }, compilation: { platformConfig: { target: '../..' } }, slither: { useSlither: false } })
})

test('rescore D1 D2 a done plan scores again on its suite', () => {
  const { root, db } = scoring()
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  end(db, 1, 'done')
  expect(reap(root, [1])).toEqual([1])
  expect(rescore(db, root, 1, 'coo', 'error rows')).toBe(1)
  expect(planById(db, 1)).toMatchObject({ step: 2, retries: 0 })
  expect(['queued', 'running']).toContain(planById(db, 1).state)
  expect(existsSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'))).toBe(true)
  expect(supersede(db, 1)).toBeNull()
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'rescore')).toEqual([{ plan: 1, kind: 'rescore', actor: 'coo', outcome: 'pass',
    message: 'error rows', pointer: 'bench_scorecard 1', run: null }])
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const row = { plan: 1, target: 'euler-earn-m01', generator: 'fizz', ...SCORE, x_ray: null }
  expect(scores(db)).toEqual([row, row])
  expect(supersede(db, 1)).toBe(2)
  expect(runRows(db).filter((r) => r.step === 1)).toEqual([])
})

test('D3 a root medusa.json that does not parse is refused', () => {
  const { root, db } = scoring()
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), '{')
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'refuse', spans: ['bench.medusa_json'] })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench'))).toBe(false)
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
})

test('D1 scripts that make no results folder are scored', () => {
  const { root, db } = scoring(writes('.jsonl', PAIRS, false))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', ...SCORE, x_ray: null }])
})

test('calls D3 rows with 505660 calls a side record both', () => {
  const { root, db } = scoring(writes('.jsonl', PAIRS.map((r) => ({ ...r, calls: { pre_fix: 505660, fix: 505660 } }))))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ catches: 2, false_positives: 1, pre_fix_calls: 505660, fix_calls: 505660 }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ pre_fix_calls: 505660, fix_calls: 505660 })
})

test('calls D4 null sides record NULL and still score', () => {
  const { root, db } = scoring(writes('.jsonl', PAIRS.map((r) => ({ ...r, calls: { pre_fix: null, fix: null } }))))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', ...SCORE, x_ray: null }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ pre_fix_calls: null, fix_calls: null })
})

/** `scoring` with generate.json at `tokens` spawning `agents` and writing `properties`, and run_pair rows at `pre_fix` and `fix` calls a side. */
function sided(agents: number | undefined, pre_fix: number | null, fix: number | null, tokens = 1234, properties = 3) {
  const made = scoring(writes('.jsonl', PAIRS.map((r) => ({ ...r, calls: { pre_fix, fix } }))))
  put(made.root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens, seconds: 56.5, agents, properties }))
  return made
}

/** The not_powered `scored` records for `sided(...args)`, after checking score.json carries the same. */
function reason(...args: Parameters<typeof sided>): string | null | undefined {
  const { root, db } = sided(...args)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ not_powered: scores(db)[0]?.not_powered })
  return scores(db)[0]?.not_powered
}

test('D3 agents 0 or absent is reduced_generate at 505660', () => {
  expect(reason(0, 505660, 505660)).toBe('reduced_generate')
  expect(reason(undefined, 505660, 505660)).toBe('reduced_generate')
  expect(reason(8, 505660, 505660)).toBeNull()
})

test('D2 5 agents is reduced_generate, over few_properties', () => {
  expect(reason(5, 505660, 505660)).toBe('reduced_generate')
  expect(reason(5, 505660, 505660, 1234, 1)).toBe('reduced_generate')
})

test('D3 8 agents and 1 property is few_properties', () => {
  expect(reason(8, 505660, 505660, 1234, 1)).toBe('few_properties')
  expect(reason(8, 69467, 69467, 1234, 1)).toBe('few_properties')
  expect(reason(8, 505660, 505660, 1234, 3)).toBeNull()
})

test('D4 generate.json without properties counts the suite', () => {
  const { root, db } = sided(8, 505660, 505660)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5, agents: 8 }))
  writeFileSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'), suite(1))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)[0]?.not_powered).toBe('few_properties')
})

test('D4 a side under the floor or unread names that side', () => {
  expect(reason(8, 69467, 69467)).toBe('pre_fix_calls')
  expect(reason(8, 505660, null)).toBe('fix_calls')
})

const ERRORS = [{ property: 'p1', verdict: 'error', build_log_tail: 'Compiling 3 files\nError (7576): Undeclared identifier.\n  --> src/A.sol' },
  { property: 'p2', verdict: 'error', build_log_tail: 'Error: second' }]

/** `buildError` of ERRORS from both seeds. */
const TAILS = Array(2).fill(ERRORS.map((r) => r.build_log_tail).join('\n')).join('\n')

/** The bench_scorecard row and score.json `scored` writes for run_pair rows `pairs`. */
function scoredRows(pairs: object[]) {
  const { root, db } = scoring(writes('.jsonl', pairs))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  return { row: scores(db)[0], json: JSON.parse(get(root, 1, 'score.json')) as Record<string, unknown> }
}

test('1645b D1 all error rows record compile_failed and the error', () => {
  const { row, json } = scoredRows(ERRORS)
  expect(row).toMatchObject({ catches: 0, false_positives: 0, not_powered: 'compile_failed' })
  expect(json).toMatchObject({ not_powered: 'compile_failed', build_error: TAILS })
})

test('build_error keeps the last 40 lines of a long tail', () => {
  const tail = [...Array(50).keys()].map((at) => `line ${String(at + 1)}`)
  const { json } = scoredRows([{ verdict: 'error', build_log_tail: `${tail.join('\n')}\n` }])
  expect(json).toMatchObject({ build_error: tail.slice(10).join('\n') })
})

test('1645b D2 failed is compile_failed before every other reason', () => {
  expect(powered(3, 8, { pre_fix: 505660, fix: 505660 }, true)).toBe('compile_failed')
  expect(powered(1, 0, {}, true)).toBe('compile_failed')
})

test('1645b D3 one row not error scores as today, no build_error', () => {
  const { row, json } = scoredRows([...PAIRS, { ...ERRORS[0], property: 'p5' }])
  expect(row).toMatchObject({ catches: 2, false_positives: 1, not_powered: 'reduced_generate' })
  expect(json).not.toHaveProperty('build_error')
})

test('all error records the string tails, null with none', () => {
  const { row, json } = scoredRows([{ verdict: 'error', build_log_tail: 'Compiling 3 files' }, { verdict: 'error', build_log_tail: 7 }, { verdict: 'error' }])
  expect(row?.not_powered).toBe('compile_failed')
  expect(json).toMatchObject({ not_powered: 'compile_failed', build_error: 'Compiling 3 files\nCompiling 3 files' })
  expect(scoredRows([{ verdict: 'error', build_log_tail: 7 }, { verdict: 'error' }]).json).toMatchObject({ build_error: null })
})

/** A run_pair that logs the FOUNDRY_VIA_IR and FOUNDRY_OPTIMIZER_RUNS it sees to `runs`, then fails stack-too-deep, or writes PAIRS via IR when `fixed`. */
function deep(fixed: boolean): string {
  return `import json, os
seen = ' '.join(os.environ.get(k, '-') for k in ['FOUNDRY_VIA_IR', 'FOUNDRY_OPTIMIZER_RUNS'])
open('runs', 'a').write(seen + '\\n')
rows = ${JSON.stringify(PAIRS)} if ${fixed ? 'True' : 'False'} and seen.startswith('true') else [{'property': 'p1', 'verdict': 'error', 'build_log_tail': 'Compiling\\nError: Variable memPtr_102 is 1 too deep in the stack: ' + seen}]
os.makedirs('results/euler-earn-m01', exist_ok=True)
open('results/euler-earn-m01/euler-earn-m01.jsonl', 'w').write('\\n'.join(json.dumps(r) for r in rows))
`
}

/** The score row, score.json and the env each run_pair saw for `pair`, with src/foundry.toml `toml` when set. */
function retried(pair: string, toml?: string) {
  const { root, db } = scoring(pair)
  if (toml !== undefined) writeFileSync(join(srcDir(root, 1), 'foundry.toml'), toml)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  return { row: scores(db)[0], json: JSON.parse(get(root, 1, 'score.json')) as Record<string, unknown>,
    seen: readFileSync(join(planDir(root, 1), 'fuzz-bench/runs'), 'utf8').trim().split('\n') }
}

test('D1 a stack-too-deep build reruns once via IR and scores', () => {
  const { row, json, seen } = retried(deep(true))
  expect(seen).toEqual(['- -', '- -', 'true -', 'true -'])
  expect(row).toMatchObject({ catches: 2, false_positives: 1 })
  expect(json).toMatchObject({ catches: 2, false_positives: 1, via_ir_retry: true })
  expect(json).not.toHaveProperty('build_error')
})

test('D2 other compile errors or via IR already set run once', () => {
  for (const { json, seen } of [retried(`open('runs', 'a').write('-\\n')\n${writes('.jsonl', ERRORS)}`), retried(deep(false), `${TOML}[profile.fuzz]\nvia_ir = true\n`)]) {
    expect(seen).toHaveLength(2)
    expect(json).toMatchObject({ not_powered: 'compile_failed' })
    expect(json).not.toHaveProperty('via_ir_retry')
  }
})

test('D3 a rerun still too deep is compile_failed from the rerun', () => {
  const { row, json, seen } = retried(deep(false))
  expect(seen).toEqual(['- -', '- -', 'true -', 'true -'])
  expect(row?.not_powered).toBe('compile_failed')
  expect(json).toMatchObject({ not_powered: 'compile_failed', build_error: 'Compiling\nError: Variable memPtr_102 is 1 too deep in the stack: true -\nCompiling\nError: Variable memPtr_102 is 1 too deep in the stack: true -', via_ir_retry: true })
})

test('D4 run_pair sees the [profile.fuzz] keys, none without it', () => {
  expect(retried(deep(false), `${TOML}[profile.fuzz]\nvia_ir = false\noptimizer_runs = 0\n`).seen[0]).toBe('false 0')
  expect(retried(deep(false), TOML).seen[0]).toBe('- -')
})

test('D5 generate at the wall records one wall row, no pair', () => {
  const { root, db } = sided(8, 505660, 505660, CEILING)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/results/euler-earn-m01/euler-earn-m01.jsonl'))).toBe(false)
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'fizz', catches: 0, false_positives: 0, untested: null, tokens: CEILING,
    seconds: 56.5, x_ray: null, pre_fix_calls: null, fix_calls: null, not_powered: 'wall', gross_usd: 0, net_usd: 0 }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ not_powered: 'wall' })
  expect(JSON.parse(get(root, 1, 'report.json'))).toMatchObject({ result: '-', counted: { counted: 'no', why: 'wall' } })
})

const FAILS = 'import sys\nsys.stderr.write("forge build failed")\nsys.exit(1)\n'

function heldAtScore(db: Db, root: string): void {
  expect(planById(db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 2 })
  expect(holdOf(db, 1)).toEqual({ held_by: 'coo', held_why: 'forge build failed' })
  expect(maybe(root, 1, 'generate.json')).not.toBeNull()
  expect(existsSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'))).toBe(true)
  expect(eventsOf(db, 1, 'score')).toMatchObject([{ actor: 'score', outcome: 'needs_coo', message: 'forge build failed' }])
  expect(scores(db)).toEqual([])
}

test('score D2 a failing run_pair.py holds the plan for the coo', () => {
  const { root, db } = scoring(FAILS)
  expect(scored(db, root, planById(db, 1))).toEqual({ outcome: 'pass', held: true, quiet: true, spans: ['bench.run_pair'], note: 'forge build failed' })
  heldAtScore(db, root)
})

test('D1 a run_pair.py failing after a park logs the stop', () => {
  const { root, db } = scoring(FAILS)
  const stale = planById(db, 1)
  holdOn(db, 1, 'parked', null, '2026-11-02T00:00:00.000Z')
  const park = holdOf(db, 1)
  expect(scored(db, root, stale))
    .toEqual({ outcome: 'pass', held: true, quiet: true, spans: ['bench.run_pair'], note: 'run_pair.py stopped: the plan is blocked_on_ceo' })
  expect(eventsOf(db, 1, 'score')).toMatchObject([{ outcome: 'pass', message: 'run_pair.py stopped: the plan is blocked_on_ceo' }])
  expect(holdOf(db, 1)).toEqual(park)
  expect(scores(db)).toEqual([])
})

test('D2 a run_pair.py killed by SIGTERM logs the stop', () => {
  const { root, db } = scoring('import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n')
  const before = planById(db, 1)
  expect(scored(db, root, before)).toMatchObject({ outcome: 'pass', held: true, note: 'run_pair.py stopped: killed by SIGTERM' })
  expect(planById(db, 1)).toMatchObject({ state: before.state, step: 2 })
  expect(eventsOf(db, 1, 'score')).toMatchObject([{ outcome: 'pass', message: 'run_pair.py stopped: killed by SIGTERM' }])
  expect(holdOf(db, 1)?.held_by).not.toBe('coo')
  expect(scores(db)).toEqual([])
})

const KEYS = { target: 'euler-earn-m01', generator: 'fizz' }

const ON = { ...KEYS, null_check: 'true' }

/** A bench plan scored at step 2 and queued at step 3, its fuzz-bench clone's null_check.py `check`, or none when null. */
function nullChecking(keys: Record<string, string>, check: string | null = writes('.nullcheck.jsonl', KILLS)) {
  const { root, db, sha } = scoring(undefined, { ...keys, files: FILES })
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const script = join(planDir(root, 1), 'fuzz-bench/bench/null_check.py')
  if (check === null) rmSync(script)
  else writeFileSync(script, check)
  requeue(db, 1, 3)
  return { root, db, sha }
}

test('D2 null_check off passes step 3 and spawns nothing', () => {
  const { root, db } = nullChecking(KEYS)
  expect(kernel(db, root, planById(db, 1))).toEqual({ outcome: 'pass', spans: [], note: 'null_check is off in target.yml' })
  expect(existsSync(join(planDir(root, 1), NULLCHECK))).toBe(false)
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...SCORE, x_ray: null }])
})

test('D2 the refreshed copy keeps null_check on for step 3', () => {
  const { root, db } = nullChecking(ON)
  expect(get(root, 1, 'target.yml')).toBe(`${REFRESHED}null_check: true\n`)
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass', note: 'null_check.py finished: 1 untested in 2 rows' })
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...SCORE, untested: 1, x_ray: null }])
})

test('D3 a null_check.py past the cap is stopped and counted', () => {
  const { root, db, sha } = nullChecking(ON, `${writes('.nullcheck.jsonl', KILLS)}import time\ntime.sleep(60)\n`)
  expect(nullChecked(db, root, planById(db, 1), 2000))
    .toEqual({ outcome: 'pass', spans: [], note: 'null_check.py stopped at the 2000 ms cap: 1 untested in 2 rows' })
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...SCORE, untested: 1, x_ray: null }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...SCORE, untested: 1, x_ray: null, ...SEEDED })
})

test('D4 a failing null_check.py holds step 3, its row kept', () => {
  const { root, db } = nullChecking(ON, FAILS)
  expect(kernel(db, root, planById(db, 1))).toEqual({ outcome: 'pass', held: true, quiet: true, spans: ['bench.null_check'], note: 'forge build failed' })
  expect(planById(db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 3 })
  expect(holdOf(db, 1)).toEqual({ held_by: 'coo', held_why: 'forge build failed' })
  expect(eventsOf(db, 1, 'score')).toMatchObject([{ actor: 'score', outcome: 'needs_coo', message: 'forge build failed' }])
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...SCORE, x_ray: null }])
})

test('D3 D5 a held score fires no generate, and scores on return', async () => {
  const { root, db } = scoring(FAILS)
  staffedIn(root)
  dial(db, 3, AT)
  const fired = stub(1000, 'completed', true)
  await tick(db, root, fired.provider, NIGHT)
  heldAtScore(db, root)
  expect(runRows(db).filter((r) => r.seat !== 'director')).toEqual([])
  commit(join(root, 'remotes/caliperforge/fuzz-bench'), 'bench/run_pair.py', writes('.jsonl', PAIRS), 'run pair fixed')
  unhold(db, root, 1, 'coo')
  await tick(db, root, fired.provider, NIGHT)
  expect(maybe(root, 1, 'score.json')).not.toBeNull()
  expect(runRows(db).filter((r) => r.seat !== 'director')).toEqual([])
})

test('D2 no null_check.py passes step 3 with untested null', () => {
  const { root, db, sha } = nullChecking(ON, null)
  expect(nullChecked(db, root, planById(db, 1))).toEqual({ outcome: 'pass', spans: [], note: 'fuzz-bench has no bench/null_check.py' })
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...SCORE, x_ray: null }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...SCORE, x_ray: null, ...SEEDED })
})

test('D3 an empty results file is refused and not recorded', () => {
  const { root, db } = scoring(writes('.jsonl', []))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'refuse', spans: ['bench.empty_results'] })
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
})

test('D3 a suite with an empty Properties.sol is refused unscored', () => {
  const { root, db } = scoring()
  writeFileSync(join(srcDir(root, 1), 'test/fizz/Properties.sol'), 'contract Properties {}\n')
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'refuse', spans: ['bench.no_properties'] })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench'))).toBe(false)
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
})

test('D1 no results from run_pair.py is refused before null_check', () => {
  const { root, db } = scoring('import sys\n')
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'refuse', spans: ['bench.no_results'] })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench/results/euler-earn-m01/euler-earn-m01.nullcheck.jsonl'))).toBe(false)
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
})

test('score D3 no target or no generate.json is refused uncloned', () => {
  const { root, db } = scoring(undefined, { generator: 'fizz', files: FILES })
  expect(scored(db, root, planById(db, 1))).toEqual({ outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no target' })
  target(root, { target: 'euler-earn-m01', generator: 'fizz', files: FILES })
  rmSync(join(planDir(root, 1), 'generate.json'))
  expect(scored(db, root, planById(db, 1))).toEqual({ outcome: 'refuse', spans: ['generate.json'], note: 'generate.json is missing' })
  expect(existsSync(join(planDir(root, 1), 'fuzz-bench'))).toBe(false)
})

/** `remotes/org/fixture`: a pre-fix commit and a fix touching `path`, or nothing when null, named by checkout.json with a short fix. */
function fixedIn(root: string, path: string | null): void {
  const dir = join(root, 'remotes/org/fixture')
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  const preFix = commit(dir, 'README.md', '', 'pre-fix')
  if (path === null) git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'fix'])
  else commit(dir, path, 'contract Vault {}\n', 'fix')
  put(root, 1, 'checkout.json', JSON.stringify({ repo: 'org/fixture', fix: git(dir, ['rev-parse', '--short=8', 'HEAD']).trim(), pre_fix: preFix }))
}

test('score D1 D5 unlisted upstream gets the fix paths', () => {
  const { root, db } = scoring(undefined, KEYS)
  commit(join(root, 'remotes/caliperforge/fuzz-bench'), 'targets/euler-earn-m01.yml', 'repo: euler-xyz/euler-earn\n', 'no files')
  fixedIn(root, 'src/vault.sol')
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const listed = `repo: euler-xyz/euler-earn\nfiles: ${FILES}\n`
  expect(readFileSync(join(planDir(root, 1), 'fuzz-bench/targets/euler-earn-m01.yml'), 'utf8')).toBe(listed)
  expect(get(root, 1, 'target.yml')).toBe(`${listed}target: euler-earn-m01\ngenerator: fizz\n`)
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...SCORE, x_ray: null }])
  expect(existsSync(join(planDir(root, 1), 'resolve.git'))).toBe(false)
})

test('D2 D3 D4 upstream files kept, none derivable refused', () => {
  const { root, db } = scoring(undefined, KEYS)
  const upstream = (files: string, on = db) => {
    commit(join(root, 'remotes/caliperforge/fuzz-bench'), 'targets/euler-earn-m01.yml', `repo: euler-xyz/euler-earn\nfiles: ${files}\n`, 'target')
    return scored(on, root, planById(on, 1))
  }
  const refused = { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no files' }
  for (const files of ['', '[]']) expect(upstream(files)).toEqual(refused)
  fixedIn(root, null)
  for (const files of ['', '[]']) expect(upstream(files)).toEqual(refused)
  expect(existsSync(join(planDir(root, 1), 'resolve.git'))).toBe(false)
  expect(scores(db)).toEqual([])
  expect(maybe(root, 1, 'score.json')).toBeNull()
  for (const files of [FILES, 'src/vault.sol', '\n  - src/vault.sol']) {
    const again = fresh(schema)
    queued(again, 'bench', 2)
    expect(upstream(files, again)).toMatchObject({ outcome: 'pass' })
    expect(get(root, 1, 'target.yml')).toBe(`repo: euler-xyz/euler-earn\nfiles: ${files}\ntarget: euler-earn-m01\ngenerator: fizz\n`)
  }
  target(root, { generator: 'fizz' })
  expect(scored(db, root, planById(db, 1)).note).toBe('target.yml has no target')
})

test('D3 house_generator generates and is scored under its name', async () => {
  const { root, db } = scoring(undefined, { target: 'euler-earn-m01', generator: 'house_generator', files: FILES })
  staffedIn(root)
  rmSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'))
  const fired = stub(1234, 'completed', ['test/fizz/House.sol'], null, false, 'contract House {\n  function property_a() public {}\n  function property_b() public {}\n  function property_c() public {}\n}\n', 0)
  expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), fired.provider)).toMatchObject({ outcome: 'pass' })
  expect(fired.packets).toMatchObject([{ tools: seat(root, 'house_generator').manifest.tools }])
  expect(fired.packets[0]?.reads).toEqual([real(ATTEMPTS)])
  expect(fired.packets[0]?.prompt).not.toContain('SKILL_PATH')
  expect(fired.packets[0]?.prompt).not.toContain('Order of work')
  expect(fired.packets[0]?.idle).toBeUndefined()
  expect(runRows(db)).toMatchObject([{ seat: 'house_generator', staffed: 'house_generator' }])
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toEqual([{ plan: 1, target: 'euler-earn-m01', generator: 'house_generator', ...SCORE, tokens: 1234, seconds: 1, x_ray: 0 }])
})

test('D3 a run that wrote x-ray.md is scored with x_ray 1', async () => {
  const { root, db, sha } = scoring(undefined, { target: 'euler-earn-m01', generator: 'house_generator', files: FILES })
  staffedIn(root)
  expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), stub(1234, 'completed', true, null, true, BODY, 0).provider))
    .toMatchObject({ outcome: 'pass' })
  expect(kernel(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ plan: 1, x_ray: 1 }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...SCORE, seconds: 1, x_ray: 1, ...SEEDED })
})

const REFUZZ = { ...KEYS, files: FILES, refuzz: '7', hours: '4', seeds: '2' }

/** A stub run_pair that writes `silent` for p1 to p3 on an empty corpus and `catch` on a grown one, then grows it. */
const CORPUS = `import json, os, sys
name = os.path.basename(sys.argv[2])
corpus = json.load(open(os.path.join(sys.argv[2], 'medusa.json')))['fuzzing']['corpusDirectory']
os.makedirs(corpus, exist_ok=True)
pre_fix = 'fail' if os.listdir(corpus) else 'pass'
os.makedirs(f'results/{name}', exist_ok=True)
open(f'results/{name}/{name}.jsonl', 'w').write('\\n'.join(json.dumps({'property': p, 'pre_fix': pre_fix, 'fix': 'pass', 'calls': {'pre_fix': 10, 'fix': 20}}) for p in ['p1', 'p2', 'p3']))
open(os.path.join(corpus, str(len(os.listdir(corpus)))), 'w').write('x')
`

test('refuzz D4 the medusa.json runs hours long on one corpus', () => {
  const { root, db } = scoring(undefined, REFUZZ)
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { timeout: 600, workers: 10, testLimit: 500000 } }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))).toEqual({
    fuzzing: { timeout: 14400, workers: 4, testLimit: 0, corpusDirectory: join(planDir(root, 7), 'corpus'), shrinkLimit: 500 },
    slither: { useSlither: false } })
  expect(get(root, 1, 'target.yml')).toBe('repo: euler-xyz/euler-earn\nfiles:\n  - src/EulerEarn.sol\nmode: refuzz\ntarget: euler-earn-m01\ngenerator: fizz\nrefuzz: 7\nhours: 4\nseeds: 2\n')
  expect(readFileSync(join(planDir(root, 1), 'fuzz-bench/targets/euler-earn-m01.yml'), 'utf8')).toMatch(/mode: refuzz\n$/)
})

test('refuzz D4 a medusa.json with no fuzzing still gets them', () => {
  const { root, db } = scoring(undefined, REFUZZ)
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), '{}')
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/medusa.json'), 'utf8'))).toEqual({
    fuzzing: { timeout: 14400, workers: 4, testLimit: 0, corpusDirectory: join(planDir(root, 7), 'corpus'), shrinkLimit: 500 },
    slither: { useSlither: false } })
})

test('refuzz D5 D6 each seed scores on the corpus the last grew', () => {
  const { root, db, sha } = scoring(CORPUS, REFUZZ)
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { workers: 2 } }))
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 0, seconds: 0, agents: 8, properties: 3 }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(join(planDir(root, 1), 'fuzz-bench/results/euler-earn-m01')).sort()).toEqual(['euler-earn-m01.seed-1.jsonl', 'euler-earn-m01.seed-2.jsonl'])
  const score = { catches: 3, false_positives: 0, untested: null, tokens: 0, seconds: 0, x_ray: null, pre_fix_calls: 20, fix_calls: 40, not_powered: null,
    gross_usd: 0, net_usd: 0 }
  expect(scores(db)).toEqual([{ plan: 1, ...KEYS, ...score }])
  const calls = { pre_fix: 10, fix: 20 }
  const seconds = expect.any(Number) as number
  const none = { false_positive: 0, broken: 0, not_run: 0 }
  expect(JSON.parse(get(root, 1, 'score.json'))).toEqual({ fuzz_bench: sha, ...score, mode: 'refuzz', source: 7, broken: 0, flaky: 0,
    seeds: [{ seed: 1, catch: 0, ...none, silent: 3, calls, seconds }, { seed: 2, catch: 3, ...none, silent: 0, calls, seconds }],
    union: { catch: 3, ...none, flaky: 0, silent: 0 } })
  expect(JSON.parse(get(root, 1, 'report.json'))).toMatchObject({ result: { catch: 3, flaky: 0, p1: ['silent', 'catch'] } })
  expect(runRows(db)).toEqual([])
})

test('refuzz D5 union: pass→fail, fail→pass, pass→pass', () => {
  const { root, db } = scoring(writes('.jsonl', PAIRS), REFUZZ)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ catches: 2, false_positives: 1, union: { catch: 2, false_positive: 1, silent: 1 } })
})

test('refuzz D6 short calls pass; all error is compile_failed', () => {
  expect(powered(3, 8, { pre_fix: 1, fix: 1 }, false, true)).toBeNull()
  expect(powered(3, 8, {}, false, true)).toBeNull()
  expect(powered(3, 8, {}, true, true)).toBe('compile_failed')
  const { root, db } = scoring(writes('.jsonl', ERRORS), REFUZZ)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 0, seconds: 0, agents: 8, properties: 3 }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ not_powered: 'compile_failed' }])
})

test('refuzz D6 error rows with no property are compile_failed', () => {
  const { root, db } = scoring(writes('.jsonl', [{ verdict: 'error', pre_fix: null, fix: null, build_log_tail: 'Error: one' }, { verdict: 'error', pre_fix: null, fix: null }]), REFUZZ)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 0, seconds: 0, agents: 8, properties: 3 }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ not_powered: 'compile_failed' }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ build_error: 'Error: one\nError: one', union: { catch: 0, false_positive: 0, broken: 0, not_run: 1 } })
})

test('refuzz D7 null_check on hours 4 is capped at 4 × cap', () => {
  const { root, db } = nullChecking({ ...ON, hours: '4' }, `import time\ntime.sleep(1)\n${writes('.nullcheck.jsonl', KILLS)}`)
  expect(nullChecked(db, root, planById(db, 1), 500))
    .toEqual({ outcome: 'pass', spans: [], note: 'null_check.py finished: 1 untested in 2 rows' })
})

test('seeds D1 a score runs run_pair twice, timing each seed', () => {
  const { root, db } = scoring(`import time\ntime.sleep(0.2)\n${writes('.jsonl', PAIRS)}`)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(join(planDir(root, 1), 'fuzz-bench/results/euler-earn-m01')).sort()).toEqual(['euler-earn-m01.seed-1.jsonl', 'euler-earn-m01.seed-2.jsonl'])
  const score = JSON.parse(get(root, 1, 'score.json')) as typeof SEEDED
  expect(score).toMatchObject(SEEDED)
  for (const { seconds } of score.seeds) expect(seconds).toBeGreaterThanOrEqual(0.2)
})

/** A run_pair whose first seed catches p1 and whose second flags p2, each at its own calls. */
const SPLIT = `import json, os
open('seeded', 'a').write('x')
k = len(open('seeded').read()) - 1
rows = [{'property': 'p1', 'pre_fix': ['fail', 'pass'][k], 'fix': 'pass', 'calls': {'pre_fix': [600000, 400000][k], 'fix': [300000, 200000][k]}},
  {'property': 'p2', 'pre_fix': 'pass', 'fix': ['pass', 'fail'][k]}]
os.makedirs('results/euler-earn-m01', exist_ok=True)
open('results/euler-earn-m01/euler-earn-m01.jsonl', 'w').write('\\n'.join(json.dumps(r) for r in rows))
`

test('seeds D2 the union counts, the smallest seed is powered', () => {
  const { root, db } = scoring(SPLIT)
  put(root, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1234, seconds: 56.5, agents: 8, properties: 3 }))
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ catches: 0, false_positives: 0, pre_fix_calls: 400000, fix_calls: 200000, not_powered: 'fix_calls' }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ flaky: 2, union: { catch: 0, false_positive: 0, broken: 0, flaky: 2, silent: 0, not_run: 0 },
    seeds: [{ seed: 1, catch: 1, false_positive: 0, silent: 1, calls: { pre_fix: 600000, fix: 300000 } }, { seed: 2, catch: 0, false_positive: 1, silent: 1, calls: { pre_fix: 400000, fix: 200000 } }] })
})

/** pre_fix and fix on each of two seeds: four probes fail on both, mint and deposit_full differ by seed. */
const PROBES = { ...Object.fromEntries([1, 2, 3, 4].map((n) => [`property_probe${String(n)}`, [['fail', 'fail'], ['fail', 'fail']]])),
  'assert:eulerEarn_mint': [['pass', 'fail'], ['fail', 'fail']], 'assert:eulerEarn_deposit_full': [['fail', 'pass'], ['pass', 'fail']],
  ...Object.fromEntries(['clamped', 'full', 'twoSources'].map((s) => [`assert:publicAllocator_reallocateTo_${s}`, [['fail', 'pass'], ['fail', 'pass']]])),
  'assert:eulerEarn_withdraw': [['pass', 'pass'], ['pass', 'pass']], 'assert:eulerEarn_redeem': [[null, null], [null, null]] }

const PROBED = `import json, os
open('seeded', 'a').write('x')
k = len(open('seeded').read()) - 1
rows = [{'property': p, 'pre_fix': s[k][0], 'fix': s[k][1]} for p, s in json.loads(${JSON.stringify(JSON.stringify(PROBES))}).items()]
os.makedirs('results/euler-earn-m01', exist_ok=True)
open('results/euler-earn-m01/euler-earn-m01.jsonl', 'w').write('\\n'.join(json.dumps(r) for r in rows))
`

test('failing on both commits is broken, not a false positive', () => {
  const { root, db } = scoring(PROBED)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(scores(db)).toMatchObject([{ catches: 3, false_positives: 0 }])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject({ catches: 3, false_positives: 0, broken: 4, flaky: 2,
    seeds: [{ broken: 4, false_positive: 1 }, { broken: 5, false_positive: 1 }], union: { catch: 3, false_positive: 0, broken: 4, flaky: 2, silent: 1, not_run: 1 } })
  expect(JSON.parse(get(root, 1, 'report.json'))).toMatchObject({ result: { broken: 4, 'assert:eulerEarn_mint': ['false alarm', 'broken'],
    'assert:eulerEarn_redeem': ['not run', 'not run'] } })
})

function said(db: Db, kind: string, message: unknown, outcome: Event['outcome'] = 'pass'): void {
  logged(db, { plan: 1, kind, actor: 'test', outcome, message: typeof message === 'string' ? message : JSON.stringify(message), pointer: null, run: null })
}

/** The report.json and report.md `scored` writes for a powered PAIRS run, once `log` has logged its events. */
function reported(log: (db: Db) => void) {
  const { root, db } = sided(8, 505660, 505660)
  log(db)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  return { json: JSON.parse(get(root, 1, 'report.json')) as Record<string, unknown>, md: get(root, 1, 'report.md') }
}

const RESULT = { catch: 2, false_positive: 1, broken: 0, flaky: 0, silent: 1, not_run: 0, p1: ['catch', 'catch'], p2: ['catch', 'catch'], p3: ['false alarm', 'false alarm'], p4: ['silent', 'silent'] }

const TITLES = ['Result', 'Probe readings', 'Cost', 'Map health', 'Reach', 'Checks', 'Counted']

test('report D3 D6 every section is built from its events', () => {
  const { json, md } = reported((db) => {
    for (const miss of [{ file: 'a.sol', line: 4 }, { file: 'b.sol', line: 9 }, { file: 'a.sol', line: 4 }]) said(db, KINDS.map_miss, miss)
    said(db, KINDS.slice_miss, { file: 'c.sol', line: 1 })
    said(db, KINDS.map_unused, { row: 'Vault.deposit' })
    said(db, KINDS.reach, { met: false, reasons: ['no boundary test'] })
    for (const hit of [{ check: 'critic.stand_in', state: 'found' }, { check: 'critic.stand_in', state: 'fixed' }, { check: 'critic.share_converted', state: 'left' }]) said(db, KINDS.checks, hit)
    said(db, KINDS.reach_fixes, { file: 'test/fizz/Properties.sol', note: 'bounded amount' })
    said(db, KINDS.fix_turns, { turn: 1, tokens: 100, usd: 0.5 })
    said(db, KINDS.network, 'curl https://example.com')
    said(db, KINDS.cost, { phase: 'context', tokens: 1000, usd: 2 })
    said(db, KINDS.critic, 'clean')
  })
  expect(json).toEqual({ result: RESULT, probes: '-',
    cost: { gross_usd: 0, net_usd: 0, credited: '-', phases: [{ phase: 'context', tokens: 1000, usd: 2 }], fix_turns: [{ turn: 1, tokens: 100, usd: 0.5 }] },
    map: { map_miss: 3, map_miss_top: [{ file: 'a.sol', line: 4, count: 2 }, { file: 'b.sol', line: 9, count: 1 }],
      slice_miss: 1, slice_miss_top: [{ file: 'c.sol', line: 1, count: 1 }], unused: ['Vault.deposit'] },
    reach: { met: false, reasons: ['no boundary test'] },
    checks: { hits: [{ check: 'critic.stand_in', found: 1, fixed: 1, left: 0 }, { check: 'critic.share_converted', found: 0, fixed: 0, left: 1 }],
      reach_fixes: [{ file: 'test/fizz/Properties.sol', note: 'bounded amount' }], network: ['curl https://example.com'] },
    counted: { counted: 'yes', why: '-', critic: ['pass'] } })
  expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(TITLES)
  expect(md).toContain('## Result\n\n- catch: 2\n- false_positive: 1\n- broken: 0\n- flaky: 0\n- silent: 1\n- not_run: 0\n- p1: catch; catch\n')
  expect(md).toContain('- p3: false alarm; false alarm\n')
  expect(md).toContain('- map_miss_top: file a.sol, line 4, count 2; file b.sol, line 9, count 1\n')
  expect(md).toContain('- counted: yes\n')
})

test('report D4 no events shows -, counted no with critic -', () => {
  const { json, md } = reported(() => undefined)
  expect(json).toEqual({ result: RESULT, probes: '-', cost: { gross_usd: 0, net_usd: 0, credited: '-', phases: '-', fix_turns: '-' },
    map: { map_miss: '-', map_miss_top: '-', slice_miss: '-', slice_miss_top: '-', unused: '-' }, reach: '-',
    checks: { hits: '-', reach_fixes: '-', network: '-' }, counted: { counted: 'no', why: 'no_critic', critic: '-' } })
  expect(md).toContain('## Probe readings\n\n-\n')
  expect(md).toContain('## Reach\n\n-\n')
  expect(md).toContain('- counted: no\n- why: no_critic\n- critic: -\n')
})

/** A run_pair that writes a fail→pass row for every `function property_*` in the suite it is handed. */
const PROPERTIED = `import json, os, re, sys
name = os.path.basename(sys.argv[2])
found = [p for d, _, fs in os.walk(sys.argv[2]) for f in fs if f.endswith('.sol') for p in re.findall(r'function (property_\\w+)', open(os.path.join(d, f)).read())]
os.makedirs(f'results/{name}', exist_ok=True)
open(f'results/{name}/{name}.jsonl', 'w').write('\\n'.join(json.dumps({'property': p, 'pre_fix': 'fail', 'fix': 'pass'}) for p in found))
`

const PROBING = 'contract FizzTest {\n  function property_holds() public returns (bool) { return true; }\n'
  + '  function property_probeCap() public view returns (bool) { return true; }\n  function property_probeGone() external view returns (bool) { return true; }\n}\n'

/** A suite of PROBING scored under PROPERTIED, with one corpus sequence when `corpus`, and a forge on PATH that prints only probeCap's reading. */
function probing(corpus: boolean) {
  const { root, db } = scoring(PROPERTIED)
  const sequences = join(srcDir(root, 1), 'test/fizz/fizz_data/corpus_medusa/call_sequences')
  writeFileSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'), PROBING)
  writeFileSync(join(srcDir(root, 1), 'medusa.json'), JSON.stringify({ fuzzing: { corpusDirectory: 'test/fizz/fizz_data/corpus_medusa', targetContracts: ['FizzTest'] } }))
  if (corpus) mkdirSync(sequences, { recursive: true })
  if (corpus) writeFileSync(join(sequences, '0.json'), JSON.stringify([{ call: { from: '0x10000', data: '0x12345678' } }]))
  const bin = mkdtempSync(join(tmpdir(), 'cf-forge-'))
  writeFileSync(join(bin, 'forge'), `#!/bin/sh\necho "$*" >> '${bin}/log'\necho '  probe.property_probeCap= true'\n`)
  chmodSync(join(bin, 'forge'), 0o755)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  return { root, db, md: get(root, 1, 'report.md'), forged: existsSync(join(bin, 'log')) ? readFileSync(join(bin, 'log'), 'utf8') : '' }
}

test('probes are renamed out of the scored copy and read by forge', () => {
  const { root, db, md, forged } = probing(true)
  expect(readFileSync(join(planDir(root, 1), 'fuzz-bench/suites/fizz/euler-earn-m01/FizzTest.sol'), 'utf8')).toBe(PROBING.replaceAll('property_probe', 'read_probe')
    .replace('read_probeCap() public', 'read_probeCap() internal').replace('read_probeGone() external', 'read_probeGone() internal'))
  expect(readFileSync(join(srcDir(root, 1), 'test/fizz/FizzTest.sol'), 'utf8')).toBe(PROBING)
  expect(scores(db)).toMatchObject([{ catches: 1, false_positives: 0 }])
  const { result } = JSON.parse(get(root, 1, 'report.json')) as { result: Record<string, unknown> }
  expect([result.property_holds, Object.keys(result).filter((k) => k.includes('probe'))]).toEqual([['catch', 'catch'], []])
  expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(TITLES)
  expect(md).toContain('## Probe readings\n\n- property_probeCap: true on 1 of 1 sequences\n- property_probeGone: dropped: no reading in forge output\n')
  expect(forged).toBe('test -vv --match-path test/fizz/ProbeReadings.t.sol\n')
  expect(existsSync(join(srcDir(root, 1), 'test/fizz/ProbeReadings.t.sol'))).toBe(false)
})

test('with no corpus every probe is dropped and forge never runs', () => {
  const { md, forged } = probing(false)
  expect(md).toContain('## Probe readings\n\n- property_probeCap: dropped: no corpus\n- property_probeGone: dropped: no corpus\n')
  expect(forged).toBe('')
})

test('report D5 a refused critic is not_clean, report kept', () => {
  const { json, md } = reported((db) => {
    said(db, KINDS.critic, 'clean')
    said(db, KINDS.critic, 'critic.stand_in: amount unbounded', 'refuse')
  })
  expect(json).toMatchObject({ result: RESULT, counted: { counted: 'no', why: 'not_clean', critic: ['pass', 'refuse'] } })
  expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(TITLES)
  expect(md).toContain('- counted: no\n- why: not_clean\n')
})

test('score and report carry gross, net and the credited runs', () => {
  const { root, db } = sided(8, 505660, 505660)
  upsertRule(db, { id: 'fizz_generator', kind: 'card', path: 'seats/seat.md', content_hash: 'a'.repeat(64), loaded_at: AT })
  for (const cost_usd of [1, 2, 4]) {
    addRun(db, { plan: 1, step: 1, seat: 'fizz_generator', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high', input_tokens: 1,
      cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 1, seconds: 1, exit: 0, at: AT, transcript_path: 'x.transcript.jsonl', cost_usd })
  }
  const [, two, four] = runRows(db).map(({ id }) => id)
  for (const run of [four, two]) logged(db, { plan: 1, kind: 'bench.credit', actor: 'machine', outcome: 'pass', message: 'refire', pointer: null, run: Number(run) })
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  const cost = { gross_usd: 7, net_usd: 1 }
  expect(scores(db)).toMatchObject([cost])
  expect(JSON.parse(get(root, 1, 'score.json'))).toMatchObject(cost)
  expect(JSON.parse(get(root, 1, 'report.json'))).toMatchObject({ cost: { ...cost, credited: [two, four] } })
  expect(get(root, 1, 'report.md')).toContain(`## Cost\n\n- gross_usd: 7\n- net_usd: 1\n- credited: ${String(two)}; ${String(four)}\n`)
})

test('report sets the live scored lean v4 row beside v5', () => {
  const { root, db } = scoring(writes('.jsonl', PAIRS), { target: 'euler-earn-m01', generator: 'fizz_lean_v5', files: FILES })
  for (const id of [2, 3, 4, 5]) putPlan(db, { id, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: AT, step: 2, retries: 0 })
  const lean: Score = { plan: 2, target: 'euler-earn-m01', generator: 'fizz_lean', catches: 3, false_positives: 6, untested: null, tokens: 1, seconds: 4140, x_ray: null,
    pre_fix_calls: null, fix_calls: null, not_powered: null, gross_usd: 50, net_usd: 41.81 }
  record(db, lean)
  record(db, { ...lean, plan: 3, catches: 9 })
  supersede(db, 3)
  record(db, { ...lean, plan: 4, catches: 0, not_powered: 'wall' })
  record(db, { ...lean, plan: 5, target: 'euler-earn-m02' })
  expect(scored(db, root, planById(db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(root, 1, 'report.json'))).toMatchObject({ compare: { fizz_lean: { plan: 2, net_usd: 41.81, catches: 3, false_positives: 6, seconds: 4140 },
    fizz_lean_v5: { plan: 1, net_usd: 0, catches: 2, false_positives: 1, seconds: 56.5 } } })
  const md = get(root, 1, 'report.md')
  expect(md.slice(md.indexOf('## Lean v4 vs v5'))).toBe('## Lean v4 vs v5\n\n| generator | plan | net_usd | catches | false_positives | wall_clock_s |\n| --- | --- | --- | --- | --- | --- |\n'
    + '| fizz_lean | 2 | 41.81 | 3 | 6 | 4140 |\n| fizz_lean_v5 | 1 | 0 | 2 | 1 | 56.5 |\n')
})

test('counted D6 only an unbuilt or unpowered run is not counted', () => {
  for (const reason of ['compile_failed', 'wall', 'reduced_generate', 'few_properties'] as const) expect(counted(reason, ['pass'])).toBe(reason)
  expect(counted(null, ['pass'])).toBeNull()
  expect(counted('pre_fix_calls', ['pass'])).toBeNull()
  expect(counted('fix_calls', ['pass', 'refuse'])).toBe('not_clean')
})

test('score D5 a comms plan still reaches the comms scorer', () => {
  const db = fresh(schema)
  queued(db, 'comms', mapOf('comms').steps.length - 1)
  expect(kernel(db, mkdtempSync(join(tmpdir(), 'cf-bench-')), planById(db, 1))).toEqual({ outcome: 'pass', spans: [], note: 'not a scorecard plan' })
})

const LEAN_HANDOFFS = 'test/fizz/fizz_data/handoff'
const listed = (...names: string[]) => names.map((name) => `\n## ${name}\n\n- none\n`).join('')
const LEAN_READS = '\n## Reads\n\n- x-ray/x-ray.md, Vault.deposit and Vault.redeem — the entry points to call\n'
const LEAN_FACTS = `${LEAN_READS}${listed('Signatures', 'Guards', 'Roles', 'Limits')}`
const LEAN: Record<string, string> = {
  context: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n${LEAN_FACTS}${listed('Conversion points', 'Aggregates', 'Not tracked')}`,
  scaffold: `phase: scaffold\nnext: coverage\n${LEAN_FACTS}\n## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call, only vault mints\n`,
  coverage: `phase: coverage\nnext: invariants\nfuzz_build_cmd: forge build\n${LEAN_FACTS}`,
  invariants: `phase: invariants\nnext: campaigns\n${LEAN_FACTS}\n## Converted values\n\n- property_redeemConserves | tolerance: 2 wei × 3\n`,
}
const CRITIC = "## Share-Converted Comparisons\n\n```sh\ngrep -rn 'assertEq(.*convertToAssets' {SUITE_DIR}\n```\n\n## Unbounded Stand-ins\n\n```sh\ngrep -rln 'contract Mock' {SUITE_DIR}\n```\n"
const leanPhase = (packet: Packet) => /^# Fizz lean: (\w+)/m.exec(packet.prompt)?.[1] ?? ''

/** `stub`'s generator writing each lean phase's handoff, and Properties.sol at invariants. */
function lean(): ReturnType<typeof stub> {
  const fired = stub(1000, 'completed', false)
  return { ...fired, provider: { ...fired.provider, fire: (packet) => {
    const phase = leanPhase(packet)
    mkdirSync(join(packet.cwd, LEAN_HANDOFFS), { recursive: true })
    writeFileSync(join(packet.cwd, LEAN_HANDOFFS, `${phase}.md`), LEAN[phase] ?? '')
    if (phase === 'invariants') writeFileSync(join(packet.cwd, 'test/fizz/Properties.sol'), BODY)
    return fired.provider.fire(packet)
  } } }
}

/** A clone with Vault.sol at its root, so the context check skips forge. */
function bare(root: string): void {
  const dir = srcDir(root, 1)
  git(dir, ['init', '-q'])
  put(root, 1, 'checkout.json', JSON.stringify({ pre_fix: commit(dir, 'Vault.sol', 'contract Vault {}\n', 'vault') }))
}

test('a stop_after hold waits for a ceo or coo return', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cf-fizz-home-'))
  mkdirSync(join(home, '.claude/skills/fizz/references'), { recursive: true })
  writeFileSync(join(home, '.claude/skills/fizz/references/critic-pass.md'), CRITIC)
  vi.stubEnv('HOME', home)
  try {
    const { root, db, outcome } = await generated(lean(), { generator: 'fizz_lean', stop_after: 'context' }, bare)
    expect(outcome).toMatchObject({ held: true, note: 'stopped after context for a look' })
    putPlan(db, { id: 2, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: AT, step: 0, retries: 0 })
    hold(db, root, 1, 'waits on plan 2', OPENS, 2)
    unhold(db, root, 1, 'fixer')
    const parked = lean()
    expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), parked.provider))
      .toEqual({ outcome: 'pass', held: true, spans: ['bench.stop_after'], note: 'still stopped for a look: cf unpark --by ceo or coo resumes it' })
    expect(parked.packets).toEqual([])
    expect(planById(db, 1).state).toBe('blocked_on_ceo')
    expect(existsSync(join(planDir(root, 1), 'src.stopped'))).toBe(true)
    unhold(db, root, 1, 'ceo')
    const rest = lean()
    expect(await generate(db, root, planById(db, 1), mapOf('bench').at(1), rest.provider)).toMatchObject({ outcome: 'pass' })
    expect(rest.packets.map(leanPhase)).toEqual(['scaffold', 'coverage', 'invariants'])
  } finally {
    vi.unstubAllEnvs()
  }
})
