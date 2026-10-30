import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { Provider } from '../providers/kind.ts'
import { real } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { staffed } from '../sequencer/staffing.ts'
import { firstLine } from '../sequencer/unpolled.ts'
import { cloned, get, git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import { setUntested } from '../store/bench.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { clamp, quieted } from './balances.ts'
import { deps } from './deps.ts'
import { costWall, written } from './generated.ts'
import { inBare, listedIn } from './listed.ts'
import { heldForCoo, paired, rows, seedsOf } from './paired.ts'
import { firing, phased, START } from './phases.ts'
import { buildError, kept, powered, walled } from './powered.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'
import { placed, recloned, rooted, scrapped } from './rooted.ts'

export const steps: Step[] = ['checkout', 'generate', 'score', 'null_check'].map((name, step) =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: name === 'generate' ? 'seat' : 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null }))

const NEEDED = ['repo', 'fix', 'pre_fix']

export const CEILING = 6_000_000

const SUITE = 'test/fizz'

const META = 'fizz_data'

const PROPERTY = /\bfunction\s+(?:invariant|property|echidna)_\w*\s*\(/g

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g

const PROPERTIES = 'Properties.sol'

const CAP = 60 * 60 * 1000

const CARRIED = ['null_check', 'refuzz', 'hours', 'seeds']

function ask(skill: string | undefined, xray: string | undefined, tmp: string): string {
  const said = `Generate the fuzz suite for the project in the working folder in automatic mode, asking nothing: SUITE_DIR is ${SUITE} and META_DIR is ${SUITE}/${META}. `
    + 'Run forge in the foreground, never in the background, and do not end the turn while waiting on a build. '
    + `Write throwaway scripts and notes under $TMPDIR, never /tmp. $TMPDIR is ${tmp}.`
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
  const dir = real(scrapped(root, plan.id, step.step))
  const unchecked = checkedOut(db, root, plan.id, dir)
  if (unchecked !== null) return { outcome: 'refuse', spans: ['bench.no_checkout'], note: unchecked, to: 0 }
  const uninstalled = deps(dir)
  if (uninstalled !== null) return uninstalled
  load(db, root)
  const { manifest, prompt, hash } = seat(root, name)
  const walls = costWall(db, provider.name, manifest.model)
  if ('outcome' in walls) return walls
  const granted = manifest.reads?.map((path) => real(path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(root, path))) ?? []
  mkdirSync(join(planDir(root, plan.id), 'scratch'), { recursive: true })
  const tmp = real(join(planDir(root, plan.id), 'scratch'))
  const issue = ask(granted[0], granted.find((path) => basename(path) === 'x-ray'), tmp)
  const fire = firing({ db, root, plan, step, provider, name, dir, tmp, granted, walls, ceiling: CEILING }, manifest, hash)
  const sum = name === 'fizz_lean_generator' ? await phased(fire, granted[0] ?? '', join(dir, SUITE, META, 'handoff'), issue) : await fire(prompt, issue, START)
  if ('outcome' in sum) return sum
  const { tokens, seconds, transcripts, wall } = sum
  if (wall !== null) return written(root, plan.id, dir, transcripts, { suite: SUITE, tokens, seconds, wall }, wall)
  const properties = unproven(join(dir, SUITE), `${name} (completed, ${String(tokens)} tokens)`)
  if (typeof properties !== 'number') return properties
  if (target !== '') rooted(dir, join(planDir(root, plan.id), 'fuzz-bench/suites', generator, target))
  return written(root, plan.id, dir, transcripts, { suite: SUITE, tokens, seconds, properties }, `${name} completed, ${String(tokens)} tokens, ${String(properties)} properties`)
}

export function scored(db: Db, root: string, plan: PlanRow): Outcome {
  const text = maybe(root, plan.id, 'target.yml') ?? ''
  const keys = fields(text)
  const missing = ['target', 'generator'].filter((key) => (keys[key] ?? '') === '')
  if (missing.length > 0) return { outcome: 'refuse', spans: ['target.yml'], note: `target.yml has no ${missing.join(', ')}` }
  const { target = '', generator = '' } = keys
  const made = maybe(root, plan.id, 'generate.json')
  if (made === null) return { outcome: 'refuse', spans: ['generate.json'], note: 'generate.json is missing' }
  const { suite, tokens, seconds, x_ray, agents, wall, properties } = JSON.parse(made) as { suite: string; tokens: number; seconds: number; x_ray?: 0 | 1; agents?: number; wall?: string; properties?: number }
  const stop = wall?.replace(/^ruling:/, '') ?? (tokens >= CEILING ? `the token wall after ${String(tokens)} tokens` : null)
  const proven = stop !== null ? walled(db, root, plan.id, { target, generator }, { tokens, seconds, x_ray: x_ray ?? null }, stop) : unproven(join(srcDir(root, plan.id), suite), generator)
  if (typeof proven !== 'number') return proven
  const config = medusa(db, plan.id, srcDir(root, plan.id), suite, keys.refuzz === undefined ? null : { hours: Number(keys.hours), corpus: join(planDir(root, Number(keys.refuzz)), 'corpus') })
  if (config !== null && 'outcome' in config) return config
  const bench = join(planDir(root, plan.id), 'fuzz-bench')
  const suites = `suites/${generator}/${target}`
  recloned(bench, suites, remote(gitBase(root), 'caliperforge/fuzz-bench'))
  const sha = git(bench, ['rev-parse', 'HEAD']).trim()
  const upstream = join(bench, 'targets', `${target}.yml`)
  if (!existsSync(upstream)) return { outcome: 'refuse', spans: ['target.yml'], note: `fuzz-bench has no targets/${target}.yml` }
  const yml = moded(upstream, listedIn(root, plan.id, upstream), keys.refuzz)
  if (yml === null) return { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no files' }
  put(root, plan.id, 'target.yml', `${copied(yml, target, generator)}${
    CARRIED.filter((key) => keys[key] !== undefined).map((key) => `${key}: ${keys[key] ?? ''}\n`).join('')}`)
  cpSync(join(srcDir(root, plan.id), suite), join(bench, suites), { recursive: true })
  rooted(srcDir(root, plan.id), join(bench, suites))
  const dropped = config === null ? null : placed(config.config, srcDir(root, plan.id), join(bench, suites))
  mkdirSync(join(bench, 'results', target), { recursive: true })
  const runs = paired(db, plan, bench, target, suites, keys.refuzz === undefined ? null : Number(keys.seeds))
  if (!Array.isArray(runs)) return runs
  const pairs = runs.flat()
  const seeded = keys.refuzz === undefined ? null : seedsOf(runs)
  const calls = seeded?.calls ?? pairs[0]?.calls
  const score = { catches: seeded?.union.catch ?? pairs.filter((r) => r.verdict === 'catch').length, false_positives: seeded?.union.fp_candidate ?? pairs.filter((r) => r.verdict === 'fp_candidate').length,
    untested: null, tokens, seconds, x_ray: x_ray ?? null, pre_fix_calls: calls?.pre_fix ?? null, fix_calls: calls?.fix ?? null, not_powered: powered(properties ?? proven, agents, calls, pairs.every((r) => r.verdict === 'error'), seeded !== null) }
  kept(db, root, plan.id, { target, generator }, score, sha, { ...(dropped === null ? {} : { foundry_out_dropped: dropped }), ...(score.not_powered === 'compile_failed' ? { build_error: buildError(pairs) } : {}),
    ...(seeded === null ? {} : { mode: 'refuzz', source: Number(keys.refuzz), seeds: seeded.seeds, union: seeded.union }) })
  return { outcome: 'pass', spans: [], note: `score.json written at fuzz-bench ${sha.slice(0, 12)}${config === null || config.clamped.length === 0
    ? '' : `; targetContractsBalances ${config.clamped.join(', ')} clamped to 1e24 wei`}` }
}

/** run_pair writes its 250k `testLimit` over the suite's unless the yml it is handed says `mode: refuzz`: https://github.com/caliperforge/fuzz-bench/pull/59 (run_pair.py:296) */
function moded(upstream: string, listed: string | null, refuzz: string | undefined): string | null {
  if (listed === null || refuzz === undefined) return listed
  const yml = `${listed.trimEnd()}\nmode: refuzz\n`
  writeFileSync(upstream, yml)
  return yml
}

export function nullChecked(db: Db, root: string, plan: PlanRow, cap = CAP): Outcome {
  const { target = '', generator = '', null_check: on, hours } = fields(maybe(root, plan.id, 'target.yml') ?? '')
  if (on !== 'true') return { outcome: 'pass', spans: [], note: 'null_check is off in target.yml' }
  const bench = join(planDir(root, plan.id), 'fuzz-bench')
  if (!existsSync(join(bench, 'bench/null_check.py'))) return { outcome: 'pass', spans: [], note: 'fuzz-bench has no bench/null_check.py' }
  const limit = cap * Number(hours ?? 1)
  const ran = spawnSync('python3', ['bench/null_check.py', `targets/${target}.yml`, `suites/${generator}/${target}`],
    { cwd: bench, encoding: 'utf8', timeout: limit })
  const capped = (ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  if (!capped && (ran.error !== undefined || ran.status !== 0)) return heldForCoo(db, plan, ran, 'null_check')
  const ended = capped ? `stopped at the ${String(limit)} ms cap` : 'finished'
  const kills = join(bench, 'results', target, `${target}.nullcheck.jsonl`)
  if (!existsSync(kills)) return { outcome: 'pass', spans: [], note: `null_check.py ${ended} with no results/${target}/${target}.nullcheck.jsonl` }
  const counted = rows(kills)
  const untested = counted.filter((r) => r.untested === true).length
  setUntested(db, plan.id, untested)
  put(root, plan.id, 'score.json', JSON.stringify({ ...JSON.parse(get(root, plan.id, 'score.json')) as object, untested }))
  return { outcome: 'pass', spans: [], note: `null_check.py ${ended}: ${String(untested)} untested in ${String(counted.length)} rows` }
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

/** run_pair installs the suite at `test/<target>/` and Medusa resolves from the config's folder; fizz wrote these from the project root. */
const MOVED: [string[], string][] = [[['fuzzing'], 'corpusDirectory'], [['logging'], 'logDirectory'],
  [['compilation', 'platformConfig'], 'target'], [['compilation', 'platformConfig'], 'exportDirectory'], [['slither'], 'cachePath']]

const TIMEOUT = 3600

const WORKERS = 4

function medusa(db: Db, plan: number, src: string, suite: string, refuzz: { hours: number; corpus: string } | null): Outcome | { config: unknown; clamped: string[] } | null {
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
  if (refuzz !== null && field(config, 'fuzzing') === undefined) Object.assign(config as object, { fuzzing: {} })
  const fuzzing = field(config, 'fuzzing')
  const balances = field(fuzzing, 'targetContractsBalances')
  const { entries, clamped } = clamp(Array.isArray(balances) ? balances : [])
  if (typeof fuzzing === 'object' && fuzzing !== null) {
    const { timeout, workers } = fuzzing as Record<string, unknown>
    Object.assign(fuzzing, { timeout: timeout === 0 || timeout === undefined ? TIMEOUT : timeout,
      workers: typeof workers === 'number' && workers <= WORKERS ? workers : WORKERS })
    if (Array.isArray(balances)) Object.assign(fuzzing, { targetContractsBalances: entries })
    if (refuzz !== null) Object.assign(fuzzing, { timeout: refuzz.hours * 3600, testLimit: 0, corpusDirectory: refuzz.corpus })
  }
  return { config: quieted(config), clamped }
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
