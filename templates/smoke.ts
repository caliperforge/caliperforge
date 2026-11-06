import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { BUILD } from './extract.ts'
import type { Refused } from './handoff.ts'
import { measured, type Revert } from './reach.ts'
import { callee, NONE, rows } from './slices.ts'

export interface Smoked { name: string; calls: number; successes: number }

export interface Ran { results: Smoked[]; note: string | null; cache: string | null }

const REPORT = 'corpus_medusa/coverage/revert_report.json'
const SECONDS = '120'
const COMPILE = 1200
const IGNORE = '--foundry-ignore-compile'
const TAIL = 2000
const FORCED = [...BUILD, '--force']
const CRYTIC = ['.', IGNORE, '--export-format', 'solc']
const STAMP = 'cache/fizz-build-info.json'
const INFO = 'out/build-info'
const SKIPPED = ['out', 'cache', '.git']
const OUT = 'cache/fizz-slither-out'
const SCOPED = ['build', '--build-info', '--out', OUT, '--cache-path', 'cache/fizz-slither-cache', 'src', 'test/fizz']
const SLITHER = ['.', '--ignore-compile', '--foundry-out-directory', OUT, '--print', 'echidna', '--json', '-']

export function smoked(map: string, report: string): Smoked[] {
  const metrics = measured(JSON.parse(readFileSync(report, 'utf8')) as Revert)
  const mapped = rows(map)
  const handlers = mapped.get('Handlers') ?? []
  return (mapped.get('Selected entry points') ?? []).filter((r) => r.name !== NONE).map(({ name }) => {
    const read = handlers.filter((h) => h.cells.get('target') === callee(name)).map((h) => metrics(h.name))
    const calls = read.reduce((n, m) => n + m.totalCalls, 0)
    return { name, calls, successes: calls - read.reduce((n, m) => n + m.totalReverts, 0) }
  })
}

export function unrun(map: string, results: Smoked[]): Refused[] {
  const unclamped = (rows(map).get('Unclamped') ?? []).map((r) => r.name)
  return results.filter((r) => r.successes === 0 && unclamped.includes(callee(r.name))).map((r) => ({ rule: 'smoke.unclamped',
    note: `smoke: ${r.name} is raw-only and made 0 successful calls in ${String(r.calls)}; it needs a clamped handler` }))
}

interface Config { fuzzing?: object; slither?: { useSlither?: boolean; cachePath?: string }; compilation?: { platformConfig?: { args?: string[] } } }

function reusing({ compilation }: Config): Config['compilation'] {
  const args = (compilation?.platformConfig?.args ?? []).filter((arg) => arg !== '--foundry-compile-all')
  return { ...compilation, platformConfig: { ...compilation?.platformConfig, args: args.includes(IGNORE) ? args : [...args, IGNORE] } }
}

function sources(root: string): string {
  const paths = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.sol') && !SKIPPED.some((dir) => path.startsWith(`${dir}${sep}`)))
  if (existsSync(join(root, 'foundry.toml'))) paths.push('foundry.toml')
  const hash = createHash('sha256')
  for (const path of paths.sort()) hash.update(`${path}\n`).update(readFileSync(join(root, path)))
  return hash.digest('hex')
}

interface Stamp { sources: string; files: string[] }

function held(root: string, hash: string): boolean {
  if (!existsSync(join(root, STAMP))) return false
  const stamp = JSON.parse(readFileSync(join(root, STAMP), 'utf8')) as Stamp
  return stamp.sources === hash && stamp.files.every((file) => existsSync(join(root, INFO, file)))
}

function built(root: string, hash: string, compile: number): Refused | undefined {
  if (!held(root, hash)) {
    const started = Date.now()
    const forged = spawnSync('forge', FORCED, { cwd: root, encoding: 'utf8', timeout: compile * 1000 })
    if ((forged.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return { rule: 'smoke.compile_slow',
      note: `smoke: forge ${FORCED.join(' ')} ran past its ${String(compile)} s limit and was stopped after ${String(Math.round((Date.now() - started) / 1000))} s; medusa did not run` }
    if (forged.status !== 0) throw new Error(`forge ${FORCED.join(' ')} exited ${String(forged.status)}: ${(forged.error?.message ?? forged.stderr).slice(-TAIL)}`)
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(join(root, STAMP), JSON.stringify({ sources: hash, files: readdirSync(join(root, INFO)).sort() } satisfies Stamp))
  }
  const crytic = spawnSync('crytic-compile', CRYTIC, { cwd: root, encoding: 'utf8', timeout: compile * 1000 })
  if (crytic.status !== 0) return { rule: 'smoke.compile_failed',
    note: `smoke: crytic-compile ${CRYTIC.join(' ')} exited ${String(crytic.status)}; last 20 lines:\n${(crytic.error?.message ?? crytic.stderr).trimEnd().split('\n').slice(-20).join('\n')}` }
  return undefined
}

type Slither = { cache: string } | { note: string }

const why = (ran: { error?: Error; status: number | null }, compile: number): string =>
  (ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? `ran past its ${String(compile)} s limit` : `exited ${String(ran.status)}`

function slithered(root: string, hash: string, compile: number): Slither {
  const cache = `cache/fizz-slither-${hash}.json`
  const [at, deadline] = [join(root, cache), Date.now() + compile * 1000]
  if (existsSync(at)) return { cache }
  const forged = spawnSync('forge', SCOPED, { cwd: root, timeout: compile * 1000, stdio: 'ignore' })
  if (forged.status !== 0) return { note: `smoke: forge ${SCOPED.join(' ')} ${why(forged, compile)}; medusa ran with slither off` }
  const fd = openSync(`${at}.part`, 'w')
  const ran = spawnSync('slither', SLITHER, { cwd: root, timeout: Math.max(deadline - Date.now(), 1), stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' })
  closeSync(fd)
  if (ran.status === 0) {
    renameSync(`${at}.part`, at)
    return { cache }
  }
  rmSync(`${at}.part`)
  return { note: `smoke: slither ${SLITHER.join(' ')} ${why(ran, compile)}; medusa ran with slither off` }
}

const block = (config: Config, slither: Slither): Config['slither'] =>
  'cache' in slither ? { ...config.slither, useSlither: true, cachePath: slither.cache } : { ...config.slither, useSlither: false }

export function primed(root: string, compile = COMPILE): string | null {
  const path = join(root, 'medusa.json')
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config
  const { useSlither, cachePath } = config.slither ?? {}
  if (useSlither === false || (cachePath !== undefined && existsSync(resolve(root, cachePath)))) return null
  const slither = slithered(root, sources(root), compile)
  writeFileSync(path, JSON.stringify({ ...config, slither: block(config, slither) }, null, 2))
  return 'note' in slither ? slither.note : null
}

export function smoke(root: string, fizz: string, meta: string, map: string, wall = Number(SECONDS) + 60, compile = COMPILE): Ran | Refused {
  const hash = sources(root)
  const refused = built(root, hash, compile)
  if (refused !== undefined) return refused
  const slither = slithered(root, hash, compile)
  const [path, report] = [join(root, 'medusa.json'), join(root, meta, REPORT)]
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config
  const kept = { ...config, slither: block(config, slither) }
  rmSync(report, { force: true })
  writeFileSync(path, JSON.stringify({ ...kept, fuzzing: { ...config.fuzzing, revertReporterEnabled: true }, compilation: reusing(config) }, null, 2))
  let ran: SpawnSyncReturns<string>
  try {
    ran = spawnSync(process.execPath, [join(import.meta.dirname, 'walled.ts'), String(wall), 'node', join(fizz, 'scripts/run_medusa.js'), root, '--meta-dir', meta, '--timeout', SECONDS],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
  } finally {
    writeFileSync(path, JSON.stringify(kept, null, 2))
  }
  if (ran.status === 124) return { rule: 'smoke.hung',
    note: `smoke: medusa ran past --timeout ${SECONDS} + 60 s and its process group was killed; last 40 lines:\n${ran.stderr.trimEnd().split('\n').slice(-40).join('\n')}` }
  if (!existsSync(report)) throw new Error(`run_medusa.js exited ${String(ran.status)} and wrote no ${report}: ${ran.stderr.slice(-TAIL)}`)
  return { results: smoked(map, report), note: 'note' in slither ? slither.note : null, cache: 'cache' in slither ? slither.cache : null }
}

export const packed = (results: Smoked[]): string =>
  results.map((r) => `- ${r.name} | calls: ${String(r.calls)} | successes: ${String(r.successes)}\n`).join('')
