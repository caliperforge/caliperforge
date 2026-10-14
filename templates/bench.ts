import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import { git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import type { PlanRow } from '../store/plans.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

export const steps: Step[] = ['checkout', 'generate', 'score'].map((name, step) =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null }))

const NEEDED = ['repo', 'fix', 'pre_fix']

export function scratch(root: string, plan: PlanRow): Outcome {
  const text = maybe(root, plan.id, 'target.yml')
  if (text === null) return { outcome: 'refuse', spans: ['target.yml'], note: 'target.yml is missing' }
  const target: Record<string, string | undefined> = Object.fromEntries(text.split('\n')
    .map((line) => /^(\w+):\s*(.*)$/.exec(line)).filter((m) => m !== null).map((m) => [m[1] ?? '', m[2]?.trim()] as const))
  const missing = NEEDED.filter((key) => (target[key] ?? '') === '')
  if (missing.length > 0) return { outcome: 'refuse', spans: ['target.yml'], note: `target.yml has no ${missing.join(', ')}` }
  const { repo = '', fix = '', pre_fix: preFix = '' } = target
  const url = remote(gitBase(root), repo)
  const sha = resolved(planDir(root, plan.id), url, preFix)
  rmSync(srcDir(root, plan.id), { recursive: true, force: true })
  const dir = srcDir(root, plan.id)
  git(dir, ['init', '-q'])
  git(dir, ['fetch', '-q', '--depth', '1', url, sha])
  git(dir, ['checkout', '-q', 'FETCH_HEAD'])
  if (spawnSync('git', ['cat-file', '-e', `${fix}^{commit}`], { cwd: dir }).status === 0) {
    return { outcome: 'refuse', spans: ['bench.fix_reachable'], note: `fix ${fix} is in the scratch tree at ${sha.slice(0, 12)}` }
  }
  for (const needle of [target.finding ?? '', basename(target.report ?? '')].filter((n) => n !== '')) {
    const where = seen(dir, needle)
    if (where !== null) return { outcome: 'refuse', spans: ['bench.seen'], note: `"${needle}" is in ${where}` }
  }
  put(root, plan.id, 'checkout.json', JSON.stringify({ repo, fix, pre_fix: sha }))
  return { outcome: 'pass', spans: [], note: `checkout.json written at ${sha.slice(0, 12)}` }
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
  if (path !== undefined) return `the path ${path}`
  const file = spawnSync('git', ['grep', '-lzF', '-e', needle], { cwd: dir, encoding: 'utf8' }).stdout.split('\0')[0] ?? ''
  if (file !== '') return `the file ${file}`
  return git(dir, ['log', '--format=%B']).includes(needle) ? 'a commit message' : null
}
