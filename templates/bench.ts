import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Provider } from '../providers/kind.ts'
import { packet, real } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { staffed } from '../sequencer/staffing.ts'
import { firstLine } from '../sequencer/unpolled.ts'
import { cloned, git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import { record } from '../store/bench.ts'
import { logged, runLogged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { observed } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

export const steps: Step[] = ['checkout', 'generate', 'score'].map((name, step) =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: name === 'generate' ? 'seat' : 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null }))

const NEEDED = ['repo', 'fix', 'pre_fix']

export const CEILING = 400_000

const SUITE = 'test/fizz'

const META = 'fizz_data'

const TIMEOUTS = { BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000' }

const ATTEMPTS = '/tmp/x-ray-attempts.md'

function ask(skill: string | undefined, xray: string | undefined): string {
  const said = `Generate the fuzz suite for the project in the working folder in automatic mode, asking nothing: SUITE_DIR is ${SUITE} and META_DIR is ${SUITE}/${META}. `
    + 'Run forge in the foreground, never in the background, and do not end the turn while waiting on a build.'
  const skilled = skill === undefined ? said : `${said}\nSKILL_PATH is ${skill}. PROJECT_ROOT is the working folder: run each command from there, without cd.`
  return xray === undefined ? skilled : `${skilled}\nx-ray is installed at ${xray}: at Attempt 2, skip the git clone and run ${xray}/SKILL.md inline against PROJECT_ROOT.`
}

function fields(text: string): Record<string, string | undefined> {
  return Object.fromEntries(text.split('\n')
    .map((line) => /^(\w+):\s*(.*)$/.exec(line)).filter((m) => m !== null).map((m) => [m[1] ?? '', m[2]?.trim()] as const))
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
  const generator = fields(maybe(root, plan.id, 'target.yml') ?? '').generator ?? ''
  if (generator === '') return { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no generator' }
  const name = staffed(root, 'bench', step.step, generator)?.seat
  if (name === undefined) return { outcome: 'needs_ceo', spans: ['staffing'], note: `no bench generator "${generator}" in rules/staffing.yaml` }
  const dir = real(srcDir(root, plan.id))
  const unchecked = checkedOut(db, root, plan.id, dir)
  if (unchecked !== null) return { outcome: 'refuse', spans: ['bench.no_checkout'], note: unchecked, to: 0 }
  load(db, root)
  const { manifest, prompt, hash } = seat(root, name)
  const granted = manifest.reads?.map((path) => real(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)) ?? []
  const built = packet(manifest, prompt, '', ask(granted[0], granted.find((path) => basename(path) === 'x-ray')), dir,
    pending(planDir(root, plan.id), `step-${String(step.step)}`))
  const fired = await provider.fire({ ...built, refuse: (path) => real(resolve(dir, path)) === real(ATTEMPTS) ? null : built.refuse(path), wall: CEILING,
    env: TIMEOUTS, reads: [...granted, real(ATTEMPTS)] })
  const run = runLogged(db, { plan: plan.id, step: step.step, seat: name, rule_hash: hash, provider: provider.name, model: manifest.model,
    effort: manifest.effort, exit: fired.exit, fired, staffed: name })
  byRun(db, run, fired.transcript_path)
  observed(db, fired.limits)
  const tokens = fired.usage.input + fired.usage.output
  if (fired.ended !== 'completed' && tokens < CEILING) return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${name} ${fired.ended}` }
  const suite = join(dir, SUITE)
  if (!existsSync(suite) || !readdirSync(suite, { recursive: true, encoding: 'utf8' }).some((p) => p.endsWith('.sol') && !p.startsWith(`${META}/`))) {
    return { outcome: 'refuse', spans: ['bench.no_suite'], note: `${name} wrote no .sol under ${SUITE} outside ${META}` }
  }
  put(root, plan.id, 'generate.json', JSON.stringify({ suite: SUITE, tokens, seconds: fired.seconds,
    x_ray: existsSync(join(dir, 'x-ray/x-ray.md')) ? 1 : 0 }))
  return { outcome: 'pass', spans: [], note: `generate.json written: ${name} ${fired.ended}, ${String(tokens)} tokens` }
}

export function scored(db: Db, root: string, plan: PlanRow): Outcome {
  const keys = fields(maybe(root, plan.id, 'target.yml') ?? '')
  const missing = ['target', 'generator'].filter((key) => (keys[key] ?? '') === '')
  if (missing.length > 0) return { outcome: 'refuse', spans: ['target.yml'], note: `target.yml has no ${missing.join(', ')}` }
  const { target = '', generator = '' } = keys
  const made = maybe(root, plan.id, 'generate.json')
  if (made === null) return { outcome: 'refuse', spans: ['generate.json'], note: 'generate.json is missing' }
  const { suite, tokens, seconds, x_ray } = JSON.parse(made) as { suite: string; tokens: number; seconds: number; x_ray?: 0 | 1 }
  const bench = join(planDir(root, plan.id), 'fuzz-bench')
  rmSync(bench, { recursive: true, force: true })
  git(planDir(root, plan.id), ['clone', '-q', remote(gitBase(root), 'caliperforge/fuzz-bench'), bench])
  const sha = git(bench, ['rev-parse', 'HEAD']).trim()
  const suites = `suites/${generator}/${target}`
  cpSync(join(srcDir(root, plan.id), suite), join(bench, suites), { recursive: true })
  for (const script of ['run_pair', 'null_check'].filter((s) => s === 'run_pair' || existsSync(join(bench, `bench/${s}.py`)))) {
    const ran = spawnSync('python3', [`bench/${script}.py`, `targets/${target}.yml`, suites], { cwd: bench, encoding: 'utf8' })
    if (ran.error !== undefined || ran.status !== 0) {
      return { outcome: 'refuse', spans: [`bench.${script}`], note: ran.error?.message ?? ran.stderr.trim().split('\n').at(-1) ?? '' }
    }
  }
  const pairs = rows(join(bench, 'results', target, `${target}.jsonl`))
  if (pairs.length === 0) return { outcome: 'refuse', spans: ['bench.empty_results'], note: `results/${target}/${target}.jsonl has no rows` }
  const kills = join(bench, 'results', target, `${target}.nullcheck.jsonl`)
  const score = { catches: pairs.filter((r) => r.verdict === 'catch').length, false_positives: pairs.filter((r) => r.verdict === 'fp_candidate').length,
    untested: existsSync(kills) ? rows(kills).filter((r) => r.untested === true).length : null, tokens, seconds, x_ray: x_ray ?? null }
  record(db, { plan: plan.id, target, generator, ...score })
  put(root, plan.id, 'score.json', JSON.stringify({ fuzz_bench: sha, ...score }))
  return { outcome: 'pass', spans: [], note: `score.json written at fuzz-bench ${sha.slice(0, 12)}` }
}

function rows(path: string): { verdict?: string; untested?: boolean }[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { verdict?: string; untested?: boolean })
}

/** `pre_fix` may be a rev expression, and only a full sha can be fetched unadvertised. */
function resolved(plan: string, url: string, rev: string): string {
  const bare = join(plan, 'resolve.git')
  rmSync(bare, { recursive: true, force: true })
  try {
    git(plan, ['clone', '--bare', '-q', url, bare])
    return git(bare, ['rev-parse', '--verify', `${rev}^{commit}`]).trim()
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
}

function seen(dir: string, needle: string): string | null {
  const path = git(dir, ['ls-files', '-z']).split('\0').find((p) => p.includes(needle))
  if (path !== undefined) return `is in the path ${path}`
  const grep = spawnSync('git', ['grep', '-lzF', '-e', needle], { cwd: dir, encoding: 'utf8' })
  if (grep.status === 0) return `is in the file ${grep.stdout.split('\0')[0] ?? ''}`
  if (grep.status !== 1) return `could not be looked for: git grep exited ${String(grep.status)} ${grep.stderr.trim()}`
  return git(dir, ['log', '--format=%B']).includes(needle) ? 'is in a commit message' : null
}
