import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { Provider } from '../providers/kind.ts'
import { packet, real } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { staffed } from '../sequencer/staffing.ts'
import { firstLine } from '../sequencer/unpolled.ts'
import { cloned, get, git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import { record, setUntested } from '../store/bench.ts'
import { logged, runLogged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { observed } from '../store/lanes.ts'
import { needsCeo, type PlanRow } from '../store/plans.ts'
import { byRun, pending, spawned } from '../store/transcript.ts'
import { clamp, quieted } from './balances.ts'
import { deps } from './deps.ts'
import { inBare, listedIn } from './listed.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'
import { recloned, rooted } from './rooted.ts'

export const steps: Step[] = ['checkout', 'generate', 'score', 'null_check'].map((name, step) =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: name === 'generate' ? 'seat' : 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null }))

const NEEDED = ['repo', 'fix', 'pre_fix']

export const CEILING = 6_000_000

const SETUP = 60

const SUITE = 'test/fizz'

const META = 'fizz_data'

const PROPERTY = /\bfunction\s+(?:invariant|property|echidna)_\w*\s*\(/g

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g

const PROPERTIES = 'Properties.sol'

const TIMEOUTS = { BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000' }

const ATTEMPTS = '/tmp/x-ray-attempts.md'

const CAP = 60 * 60 * 1000

function ask(skill: string | undefined, xray: string | undefined): string {
  const said = `Generate the fuzz suite for the project in the working folder in automatic mode, asking nothing: SUITE_DIR is ${SUITE} and META_DIR is ${SUITE}/${META}. `
    + 'Run forge in the foreground, never in the background, and do not end the turn while waiting on a build.'
  const skilled = skill === undefined ? said : `${said}\nSKILL_PATH is ${skill}. PROJECT_ROOT is the working folder: run each command from there, without cd. `
    + `Order of work over the skill's: once Step 4 writes ${SUITE}/${META}/entry-point-selection.json and Step 5 scaffolds the suite, `
    + `add properties to ${SUITE}/${PROPERTIES} one at a time and save the file after each; `
    + 'write property-plan.md or run Medusa (Steps 8 and 9) only after one property compiles with forge build.'
  return xray === undefined ? skilled : `${skilled}\nx-ray is installed at ${xray}: at Attempt 2, skip the git clone and run ${xray}/SKILL.md inline against PROJECT_ROOT. Run x-ray's scripts as bash <script> and python3 <script> from PROJECT_ROOT, with no pipe, redirection or $.`
}

function fields(text: string): Record<string, string | undefined> {
  return Object.fromEntries(text.split('\n')
    .map((line) => /^(\w+):\s*(.*)$/.exec(line)).filter((m) => m !== null).map((m) => [m[1] ?? '', m[2]?.trim()] as const))
}

export function copied(yml: string, target: string, generator: string): string {
  return `${yml.trimEnd()}\ntarget: ${target}\ngenerator: ${generator}\n`
}

function checkedOut(db: Db, root: string, id: number, dir: string): string | null {
  const made = maybe(root, id, 'checkout.json')
  if (made === null) return 'checkout.json is missing'
  const { repo, pre_fix: preFix } = JSON.parse(made) as { repo?: string; pre_fix: string }
  if (!cloned(dir)) {
    if (repo === undefined) return 'src/ is not a clone'
    try {
      clone(root, id, remote(gitBase(root), repo), preFix)
    } catch (error) {
      logged(db, { plan: id, kind: 'swallowed', actor: 'generate', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
      return `src/ could not be cloned again at ${preFix.slice(0, 12)}`
    }
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  return head === preFix ? null : `src/ is at ${head.slice(0, 12)}, not pre_fix ${preFix.slice(0, 12)}`
}

function clone(root: string, id: number, url: string, sha: string): string {
  rmSync(srcDir(root, id), { recursive: true, force: true })
  const dir = srcDir(root, id)
  git(dir, ['init', '-q'])
  git(dir, ['fetch', '-q', '--depth', '1', url, sha])
  git(dir, ['checkout', '-q', 'FETCH_HEAD'])
  return dir
}

export function scratch(root: string, plan: PlanRow): Outcome {
  const text = maybe(root, plan.id, 'target.yml')
  if (text === null) return { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml is missing' }
  const target = fields(text)
  const missing = NEEDED.filter((key) => (target[key] ?? '') === '')
  if (missing.length > 0) return { outcome: 'refuse', spans: ['target.yml'], note: `target.yml has no ${missing.join(', ')}` }
  const { repo = '', fix = '', pre_fix: preFix = '' } = target
  const url = remote(gitBase(root), repo)
  const sha = resolved(planDir(root, plan.id), url, preFix)
  const dir = clone(root, plan.id, url, sha)
  if (spawnSync('git', ['cat-file', '-e', `${fix}^{commit}`], { cwd: dir }).status === 0) {
    return { outcome: 'refuse', spans: ['bench.fix_reachable'], note: `fix ${fix} is in the scratch tree at ${sha.slice(0, 12)}` }
  }
  for (const needle of [target.finding ?? '', basename(target.report ?? '')].filter((n) => n !== '')) {
    const where = seen(dir, needle)
    if (where !== null) return { outcome: 'refuse', spans: ['bench.seen'], note: `"${needle}" ${where}` }
  }
  put(root, plan.id, 'checkout.json', JSON.stringify({ repo, fix, pre_fix: sha }))
  return { outcome: 'pass', spans: [], note: `checkout.json written at ${sha.slice(0, 12)}` }
}

export async function generate(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const { generator = '', target = '' } = fields(maybe(root, plan.id, 'target.yml') ?? '')
  if (generator === '') return { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no generator' }
  const name = staffed(root, 'bench', step.step, generator)?.seat
  if (name === undefined) return { outcome: 'needs_ceo', spans: ['staffing'], note: `no bench generator "${generator}" in rules/staffing.yaml` }
  const dir = real(srcDir(root, plan.id))
  const unchecked = checkedOut(db, root, plan.id, dir)
  if (unchecked !== null) return { outcome: 'refuse', spans: ['bench.no_checkout'], note: unchecked, to: 0 }
  const uninstalled = deps(dir)
  if (uninstalled !== null) return uninstalled
  load(db, root)
  const { manifest, prompt, hash } = seat(root, name)
  const granted = manifest.reads?.map((path) => real(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)) ?? []
  const built = packet(manifest, prompt, '', ask(granted[0], granted.find((path) => basename(path) === 'x-ray')), dir,
    pending(planDir(root, plan.id), `step-${String(step.step)}`))
  const fired = await provider.fire({ ...built, refuse: (path) => real(resolve(dir, path)) === real(ATTEMPTS) ? null : built.refuse(path), wall: CEILING,
    env: TIMEOUTS, reads: [...granted, real(ATTEMPTS)], ...(name === 'fizz_generator' ? { idle: SETUP } : {}) })
  const run = runLogged(db, { plan: plan.id, step: step.step, seat: name, rule_hash: hash, provider: provider.name, model: manifest.model,
    effort: manifest.effort, exit: fired.exit, fired, staffed: name })
  const transcript = byRun(db, run, fired.transcript_path)
  observed(db, fired.limits)
  const tokens = fired.usage.input + fired.usage.output
  if (fired.ended !== 'completed' && tokens < CEILING) return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${name} ${fired.ended}` }
  const properties = unproven(join(dir, SUITE), name)
  if (typeof properties !== 'number') return properties
  if (target !== '') rooted(dir, join(planDir(root, plan.id), 'fuzz-bench/suites', generator, target))
  put(root, plan.id, 'generate.json', JSON.stringify({ suite: SUITE, tokens, seconds: fired.seconds,
    x_ray: existsSync(join(dir, 'x-ray/x-ray.md')) ? 1 : 0, agents: spawned(transcript) }))
  return { outcome: 'pass', spans: [], note: `generate.json written: ${name} ${fired.ended}, ${String(tokens)} tokens, ${String(properties)} properties` }
}

export function scored(db: Db, root: string, plan: PlanRow): Outcome {
  const text = maybe(root, plan.id, 'target.yml') ?? ''
  const keys = fields(text)
  const missing = ['target', 'generator'].filter((key) => (keys[key] ?? '') === '')
  if (missing.length > 0) return { outcome: 'refuse', spans: ['target.yml'], note: `target.yml has no ${missing.join(', ')}` }
  const { target = '', generator = '' } = keys
  const made = maybe(root, plan.id, 'generate.json')
  if (made === null) return { outcome: 'refuse', spans: ['generate.json'], note: 'generate.json is missing' }
  const { suite, tokens, seconds, x_ray } = JSON.parse(made) as { suite: string; tokens: number; seconds: number; x_ray?: 0 | 1 }
  const proven = unproven(join(srcDir(root, plan.id), suite), generator)
  if (typeof proven !== 'number') return proven
  const config = medusa(db, plan.id, srcDir(root, plan.id), suite)
  if (config !== null && 'outcome' in config) return config
  const bench = join(planDir(root, plan.id), 'fuzz-bench')
  const suites = `suites/${generator}/${target}`
  recloned(bench, suites, remote(gitBase(root), 'caliperforge/fuzz-bench'))
  const sha = git(bench, ['rev-parse', 'HEAD']).trim()
  const upstream = join(bench, 'targets', `${target}.yml`)
  if (!existsSync(upstream)) return { outcome: 'refuse', spans: ['target.yml'], note: `fuzz-bench has no targets/${target}.yml` }
  const yml = listedIn(root, plan.id, upstream)
  if (yml === null) return { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no files' }
  put(root, plan.id, 'target.yml', `${copied(yml, target, generator)}${
    keys.null_check === undefined ? '' : `null_check: ${keys.null_check}\n`}`)
  cpSync(join(srcDir(root, plan.id), suite), join(bench, suites), { recursive: true })
  rooted(srcDir(root, plan.id), join(bench, suites))
  if (config !== null) writeFileSync(join(bench, suites, 'medusa.json'), config.config)
  mkdirSync(join(bench, 'results', target), { recursive: true })
  const written = join(bench, 'results', target, `${target}.jsonl`)
  const ran = spawnSync('python3', ['bench/run_pair.py', `targets/${target}.yml`, suites], { cwd: bench, encoding: 'utf8' })
  if (ran.error !== undefined || ran.status !== 0) return heldForCoo(db, plan, ran, 'run_pair')
  if (!existsSync(written)) return { outcome: 'refuse', spans: ['bench.no_results'], note: `run_pair.py exited 0 and wrote no results/${target}/${target}.jsonl` }
  const pairs = rows(written)
  if (pairs.length === 0) return { outcome: 'refuse', spans: ['bench.empty_results'], note: `results/${target}/${target}.jsonl has no rows` }
  const score = { catches: pairs.filter((r) => r.verdict === 'catch').length, false_positives: pairs.filter((r) => r.verdict === 'fp_candidate').length,
    untested: null, tokens, seconds, x_ray: x_ray ?? null, pre_fix_calls: pairs[0]?.calls?.pre_fix ?? null, fix_calls: pairs[0]?.calls?.fix ?? null }
  record(db, { plan: plan.id, target, generator, ...score })
  put(root, plan.id, 'score.json', JSON.stringify({ fuzz_bench: sha, ...score }))
  return { outcome: 'pass', spans: [], note: `score.json written at fuzz-bench ${sha.slice(0, 12)}${config === null || config.clamped.length === 0
    ? '' : `; targetContractsBalances ${config.clamped.join(', ')} clamped to 1e24 wei`}` }
}

export function nullChecked(db: Db, root: string, plan: PlanRow, cap = CAP): Outcome {
  const { target = '', generator = '', null_check: on } = fields(maybe(root, plan.id, 'target.yml') ?? '')
  if (on !== 'true') return { outcome: 'pass', spans: [], note: 'null_check is off in target.yml' }
  const bench = join(planDir(root, plan.id), 'fuzz-bench')
  if (!existsSync(join(bench, 'bench/null_check.py'))) return { outcome: 'pass', spans: [], note: 'fuzz-bench has no bench/null_check.py' }
  const ran = spawnSync('python3', ['bench/null_check.py', `targets/${target}.yml`, `suites/${generator}/${target}`],
    { cwd: bench, encoding: 'utf8', timeout: cap })
  const capped = (ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  if (!capped && (ran.error !== undefined || ran.status !== 0)) return heldForCoo(db, plan, ran, 'null_check')
  const ended = capped ? `stopped at the ${String(cap)} ms cap` : 'finished'
  const kills = join(bench, 'results', target, `${target}.nullcheck.jsonl`)
  if (!existsSync(kills)) return { outcome: 'pass', spans: [], note: `null_check.py ${ended} with no results/${target}/${target}.nullcheck.jsonl` }
  const counted = rows(kills)
  const untested = counted.filter((r) => r.untested === true).length
  setUntested(db, plan.id, untested)
  put(root, plan.id, 'score.json', JSON.stringify({ ...JSON.parse(get(root, plan.id, 'score.json')) as object, untested }))
  return { outcome: 'pass', spans: [], note: `null_check.py ${ended}: ${String(untested)} untested in ${String(counted.length)} rows` }
}

function heldForCoo(db: Db, plan: PlanRow, ran: SpawnSyncReturns<string>, script: string): Outcome {
  const note = ran.error?.message ?? ran.stderr.trim().split('\n').at(-1) ?? ''
  needsCeo(db, plan, note)
  logged(db, { plan: plan.id, kind: 'score', actor: 'score', outcome: 'needs_coo', message: note, pointer: `step-${String(plan.step)}`, run: null })
  return { outcome: 'pass', held: true, quiet: true, spans: [`bench.${script}`], note }
}

function unproven(suite: string, name: string): Outcome | number {
  const sols = existsSync(suite) ? readdirSync(suite, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.sol') && !p.startsWith(`${META}/`)) : []
  if (sols.length === 0) return { outcome: 'refuse', spans: ['bench.no_suite'], note: `${name} wrote no .sol under ${SUITE} outside ${META}` }
  const counted = sols.includes(PROPERTIES) ? [PROPERTIES] : sols
  const properties = counted.reduce((n, p) => n + (readFileSync(join(suite, p), 'utf8').replace(COMMENT, '').match(PROPERTY)?.length ?? 0), 0)
  if (properties > 0) return properties
  return { outcome: 'refuse', spans: ['bench.no_properties'],
    note: `${name} wrote no invariant_, property_ or echidna_ function in ${counted.map((p) => `${SUITE}/${p}`).join(', ')}` }
}

interface Row { verdict?: string; untested?: boolean; calls?: { pre_fix?: number | null; fix?: number | null } }

function rows(path: string): Row[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Row)
}

/** run_pair installs the suite at `test/<target>/` and Medusa resolves from the config's folder; fizz wrote these from the project root. */
const MOVED: [string[], string][] = [[['fuzzing'], 'corpusDirectory'], [['logging'], 'logDirectory'],
  [['compilation', 'platformConfig'], 'target'], [['compilation', 'platformConfig'], 'exportDirectory'], [['slither'], 'cachePath']]

const TIMEOUT = 1200

const WORKERS = 4

function medusa(db: Db, plan: number, src: string, suite: string): Outcome | { config: string; clamped: string[] } | null {
  const installed = !existsSync(join(src, 'medusa.json'))
  const path = join(src, installed ? suite : '', 'medusa.json')
  if (!existsSync(path)) return null
  let config: unknown
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    logged(db, { plan, kind: 'swallowed', actor: 'score', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
    return { outcome: 'refuse', spans: ['bench.medusa_json'], note: firstLine(error) }
  }
  for (const [keys, key] of installed ? [] : MOVED) {
    const parent = keys.reduce(field, config)
    const value = field(parent, key)
    if (typeof value === 'string' && value !== '' && !isAbsolute(value)) Object.assign(parent as object, { [key]: moved(suite, value) })
  }
  const platform = field(field(config, 'compilation'), 'platformConfig')
  const args = field(platform, 'args') ?? []
  if (Array.isArray(args)) args.forEach((arg: unknown, at) => { if (arg === '--foundry-ignore-compile') args[at] = '--foundry-compile-all' })
  if (existsSync(join(src, 'foundry.toml')) && typeof platform === 'object' && platform !== null && Array.isArray(args) && !args.includes('--compile-force-framework')) Object.assign(platform, { args: [...(args as unknown[]), '--compile-force-framework', 'foundry'] })
  const fuzzing = field(config, 'fuzzing')
  const balances = field(fuzzing, 'targetContractsBalances')
  const { entries, clamped } = clamp(Array.isArray(balances) ? balances : [])
  if (typeof fuzzing === 'object' && fuzzing !== null) {
    const { timeout, workers } = fuzzing as Record<string, unknown>
    Object.assign(fuzzing, { timeout: timeout === 0 || timeout === undefined ? TIMEOUT : timeout,
      workers: typeof workers === 'number' && workers <= WORKERS ? workers : WORKERS })
    if (Array.isArray(balances)) Object.assign(fuzzing, { targetContractsBalances: entries })
  }
  return { config: JSON.stringify(quieted(config), null, 2), clamped }
}

function moved(suite: string, path: string): string {
  const inside = relative(suite, path)
  if (inside.startsWith('..')) return join('../..', path)
  return inside === '' ? '.' : inside
}

function field(tree: unknown, key: string): unknown {
  return typeof tree === 'object' && tree !== null ? (tree as Record<string, unknown>)[key] : undefined
}

/** A full sha goes straight to `clone`, which fetches it by itself; a rev expression on a full sha is fetched by that sha. */
function resolved(plan: string, url: string, rev: string): string {
  if (/^[0-9a-f]{40}$/.test(rev)) return rev
  return inBare(plan, url, [rev], (bare) => git(bare, ['rev-parse', '--verify', `${rev}^{commit}`]).trim())
}

function seen(dir: string, needle: string): string | null {
  const path = git(dir, ['ls-files', '-z']).split('\0').find((p) => p.includes(needle))
  if (path !== undefined) return `is in the path ${path}`
  const grep = spawnSync('git', ['grep', '-lzF', '-e', needle], { cwd: dir, encoding: 'utf8' })
  if (grep.status === 0) return `is in the file ${grep.stdout.split('\0')[0] ?? ''}`
  if (grep.status !== 1) return `could not be looked for: git grep exited ${String(grep.status)} ${grep.stderr.trim()}`
  return git(dir, ['log', '--format=%B']).includes(needle) ? 'is in a commit message' : null
}
