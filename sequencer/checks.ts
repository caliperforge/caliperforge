import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { alive } from '../store/leases.ts'
import type { Profile } from '../store/profile.ts'
import { exitedOutside } from './exited.ts'
import { gates, type Gate, type Outside, type OutsideLanguage, waived } from './gates.ts'
import { fresh } from './inherited.ts'
import { subprojects } from './loose.ts'
import { malformed } from './malformed.ts'
import { nodeTests, Package } from './node.ts'
import { unfinished } from './unfinished.ts'

export type Commands = NonNullable<Profile['commands']>

const TAIL = 80

const CAP = 10 * 60 * 1000

/** A cold Xcode build of the whole app and its tests runs well past the npm cap; so does a cold cargo build. */
const XCODE_CAP = 25 * 60 * 1000

const SUITE_CAP = 45 * 60 * 1000

const LONG = ['xcodebuild', 'cargo']

const MAX = 64 * 1024 * 1024

export interface Failure {
  /** The script the failure is named by, whatever command stood in for it. */
  script: string
  command: string
  code: string
  output: string
  /** `file:line name`, or `file name` where no line of the file holds the title; ` (timeout)` on a load block. */
  tests: string[]
  retried: boolean
  /** The xcodebuild log line saying this Mac, not the job, cannot run tests. */
  fault?: string
  /** The cap killed a run other than xcodebuild's before it named a red test, or killed a finish entry. */
  capped?: true
  /** On a capped whole vitest suite, the test files it never printed as finished. */
  unfinished?: string[]
}

export type Ran = { ok: true; output: string } | { ok: false; code: string; output: string; capped?: true }

/** `bin` is the program; left out it is `npm`, which is every checkout but an Xcode or a Kotlin one. */
export type Run = (args: string[], cwd: string, bin?: string, cap?: number) => Ran

export type Note = (doing: string, detail: string) => void

/** What a checkout is judged with: what sits at its root, or an outside plan's language. */
export type Mode = 'xcodebuild' | 'npm' | 'gradle' | 'none' | OutsideLanguage

/** Derived data stays inside the checkout, under `.cf/work`, and never under a folder macOS guards. */
const DERIVED = '.cf-derived'

const GRADLE = ['-p', 'kotlin', 'check']

export function mode(src: string): Mode {
  if (project(src) !== null) return 'xcodebuild'
  if (existsSync(join(src, 'package.json'))) return 'npm'
  return existsSync(join(src, 'kotlin')) ? 'gradle' : 'none'
}

function project(src: string): string | null {
  if (!existsSync(src)) return null
  return readdirSync(src).find((name) => name.endsWith('.xcodeproj')) ?? null
}

/**
 * `narrow` is the plan's own file list. Given one, the tests run is `vitest related` over those
 * paths -- every test the import graph says they can reach -- instead of the whole suite. The first pass
 * through step 3 passes none, so every job still runs the suite whole once, against the tree it built on.
 */
export function checks(src: string, given: Commands, run: Run = npm, narrow: string[] = [], outside: Outside | null = null, touched: string[] = [], minutes?: number, said?: (line: string) => void): Failure | null {
  if (outside !== null) return gated(src, gates(src, outside, given.excused), run, given.excused ?? [], said)
  const parsed = given.node === undefined ? null : gated(src, syntax(src, given.node, touched), run)
  if (parsed !== null) return parsed
  const unparsed = given.json === true ? malformed(src, touched) : null
  if (unparsed !== null) return unparsed
  const python = gated(src, subprojects(src, touched), run, [], said)
  if (python !== null) return python
  const bin = mode(src)
  if (bin === 'xcodebuild') excluded(src)
  for (const [script, args, program = bin] of commands(src, given, narrow, touched)) {
    const cap = program === 'npm' && script === 'test' ? SUITE_CAP : program === 'python3' && minutes !== undefined ? minutes * 60_000 : undefined
    const first = run(args, src, program, cap)
    if (first.ok) continue
    const retried = loadOnly(first.output) || (bin === 'xcodebuild' && exitedOutside(src, first.output, touched))
    const again = retried ? alone(first.output, read(src)?.[script] ?? '', args) : args
    const last = retried ? run(again, src, program, cap) : first
    if (!last.ok) return { script, command: `${program} ${args.join(' ')}`, code: last.code, output: tail(last.output), tests: entries(src, last.output), retried,
      ...faultOf(bin, last.output), ...cappedOf(bin, last, src, script, again) }
  }
  return null
}

function syntax(src: string, flags: string[], touched: string[]): Gate[] {
  return touched.filter((path) => path.endsWith('.js') && existsSync(join(src, path)))
    .map((path) => ({ script: 'node', bin: 'node', args: [...flags, path], dir: '' }))
}

function faultOf(bin: Mode, output: string): { fault?: string } {
  const line = bin === 'xcodebuild' ? output.split('\n').find((text) => FAULTS.some((f) => text.includes(f))) : undefined
  return line === undefined ? {} : { fault: line.trim() }
}

function cappedOf(bin: Mode, ran: Extract<Ran, { ok: false }>, src: string, script: string, args: string[]): Pick<Failure, 'capped' | 'unfinished'> {
  if (bin === 'xcodebuild' || ran.capped !== true || failures(ran.output).length > 0) return {}
  return args[0] === 'run' && VITEST.test(read(src)?.[script] ?? '') ? { capped: true, unfinished: unfinished(src, ran.output) } : { capped: true }
}

/**
 * A stranger's repo in a language with its own seat runs that language's gates in the language's own folder.
 * A gate marked `quiet` fails on any output, as `gofmt -l` exits zero and prints the files it would change.
 */
export function gated(src: string, list: Gate[], run: Run, excused: string[] = [], said?: (line: string) => void): Failure | null {
  for (const gate of list) {
    const first = settled(gate, run(gate.args, join(src, gate.dir), gate.bin), excused)
    if (first.ok || waived(src, gate, first.code, said)) continue
    const left = fresh(src, gate, first.output, run, said)
    if (left?.length !== 0) return { script: gate.script, command: `${gate.bin} ${gate.args.join(' ')}${gate.dir === '' ? '' : ` (in ${gate.dir}/)`}`, code: first.code, output: left === null ? tail(first.output) : left.join('\n'), tests: [], retried: false }
  }
  return null
}

export function finish(src: string, entries: Record<string, string[]>, run: Run, minutes?: number): Failure | null {
  for (const [bin = '', ...args] of Object.values(entries).filter((argv) => !missing(src, argv))) {
    const ran = run(args, src, bin, minutes === undefined ? undefined : minutes * 60_000)
    if (!ran.ok) return { script: 'finish', command: `${bin} ${args.join(' ')}`, code: ran.code, output: tail(ran.output), tests: [], retried: false,
      ...(ran.capped === true ? { capped: true as const } : {}) }
  }
  return null
}

export function missing(src: string, argv: string[]): boolean {
  const path = argv[1] ?? ''
  return path.includes('/') && !isAbsolute(path) && !existsSync(join(src, path))
}

function settled(gate: Gate, ran: Ran, excused: string[]): Ran {
  if (gate.quiet === true && ran.ok && ran.output.trim() !== '') return { ok: false, code: '1', output: ran.output }
  const spans = ran.ok ? [] : [...ran.output.matchAll(/`(-p [^`]+)`/g)].map((m) => m[1] ?? '')
  return spans.length > 0 && spans.every((s) => excused.includes(s)) ? { ok: true, output: ran.output } : ran
}

export const BUILT = [`${DERIVED}/`, '__pycache__/', '.gradle/', 'build/', 'target/', 'uv.lock', 'foundry.lock']

/** The derived data is build output: never staged, never in the diff the reviewers read. */
export function excluded(src: string): void {
  const path = join(src, '.git', 'info', 'exclude')
  if (!existsSync(join(src, '.git'))) return
  for (const line of BUILT) {
    const held = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!held.split('\n').includes(line)) appendFileSync(path, `${held.endsWith('\n') || held === '' ? '' : '\n'}${line}\n`)
  }
}

/** vitest names a failed test where it ran it and again under Failed Tests; each naming opens a block. */
const OPENS = /^[ \t]*(?:FAIL\b|×[ \t])/

const LOAD = /Test timed out in \d+ *ms|Hook timed out|expected [\d.]+ to be less than [\d.]+/

/** xcodebuild's runner never connected, so no test ran and nothing else can have failed. */
const HUNG = 'The test runner hung before establishing connection'

const FAULTS = ['CoreSimulator is out of date', HUNG]

function loadOnly(output: string): boolean {
  if (output.includes(HUNG)) return true
  const named = failures(output)
  return named.length > 0 && named.every((block) => LOAD.test(block))
}

export const NETWORK = /RPC failed|fatal: expected 'packfile'|Could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|Network is unreachable|Failed to connect to|Connection timed out|Connection reset by peer|\bcurl (?:22|56)\b|Operation timed out|TLS handshake timeout|": unexpected EOF|i\/o timeout|SSL connection timeout|\bHTTP 499\b/

export function network(output: string): string | null {
  return output.split('\n').map((line) => line.trim()).find((line) => NETWORK.test(line)) ?? null
}

export function failures(output: string): string[] {
  const blocks: string[][] = []
  for (const line of output.split('\n')) {
    if (OPENS.test(line)) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }
  return blocks.map((block) => block.join('\n'))
}

const FAILED = /^[ \t]*FAIL\b/

/** Only a `FAIL` opener carries `file > … > title`; a `×` line names the title alone. */
const TEST = /^[ \t]*FAIL[ \t]+(.+?) > (.+?)[ \t]*$/m

export function entries(src: string, output: string): string[] {
  const seen = new Map<string, string>()
  for (const block of failures(output)) {
    const hit = TEST.exec(block)
    if (hit === null) continue
    const [, file = '', name = ''] = hit
    const key = `${file} > ${name}`
    if (!seen.has(key)) seen.set(key, `${at(src, file, name.split(' > ').at(-1) ?? name)} ${name}${LOAD.test(block) ? ' (timeout)' : ''}`)
  }
  return [...seen.values()]
}

function at(src: string, file: string, title: string): string {
  const path = join(src, file)
  const line = existsSync(path) ? readFileSync(path, 'utf8').split('\n').findIndex((text) => text.includes(title)) : -1
  return line < 0 ? file : `${file}:${String(line + 1)}`
}

function alone(output: string, script: string, args: string[]): string[] {
  const opened = failures(output).filter((block) => FAILED.test(block))
  const files = opened.map((block) => TEST.exec(block)?.[1]).filter((file) => file !== undefined)
  if (!VITEST.test(script) || files.length === 0 || files.length < opened.length) return args
  return ['exec', '--', 'vitest', 'run', ...new Set(files)]
}

/** A test script that is vitest takes `related`; anything else is run whole, narrow list or not. */
const VITEST = /(^|\s)vitest(\s|$)/

function commands(src: string, given: Commands, narrow: string[], touched: string[]): [string, string[], string?][] {
  if (project(src) !== null) return given.xcodebuild === undefined ? [] : [['test', given.xcodebuild]]
  if (mode(src) === 'gradle') return [['check', GRADLE]]
  const scripts = read(src)
  if (scripts === null) return tools(src, given, touched)
  const named = (given.npm ?? []).filter((s) => scripts[s] !== undefined)
  return [
    ...(bare(src) && (named.length > 0 || given.tsc !== undefined) ? [['ci', ['ci']] as [string, string[]]] : []),
    ...named.map((s): [string, string[]] => [s, related(scripts[s] ?? '', s, narrow) ?? ['run', s]]),
    ...tools(src, given, touched),
  ]
}

export function tools(src: string, given: Commands, touched: string[]): [string, string[], string][] {
  const py = touched.filter((path) => path.endsWith('.py') && existsSync(join(src, path)))
  const tsc = given.tsc !== undefined && existsSync(join(src, 'tsconfig.json'))
    ? [['typecheck', ['exec', '--no', '--', 'tsc', ...given.tsc], 'npm'] as [string, string[], string]] : []
  return [...tsc, ...(given.forge ?? []).map((s): [string, string[], string] => [s, [s], 'forge']),
    ...(given.python3 === undefined ? [] : [['pytest', [...given.python3, ...py], 'python3'] as [string, string[], string]]),
    ...(given.node_test === true ? nodeTests(src) : [])]
}

function related(script: string, name: string, narrow: string[]): string[] | null {
  if (name !== 'test' || narrow.length === 0 || !VITEST.test(script)) return null
  return ['exec', '--', 'vitest', 'related', '--run', ...narrow]
}

export function bare(src: string): boolean {
  return existsSync(join(src, 'package-lock.json')) && !existsSync(join(src, 'node_modules'))
}

/** Our own checkout gets its dependencies before the builder fires, so the checks it may run have something to run. */
export function install(src: string, run: Run = npm): void {
  if (bare(src)) run(['ci', '--include=dev'], src)
}

function read(src: string): Record<string, string> | null {
  const path = join(src, 'package.json')
  if (!existsSync(path)) return null
  const got = Package.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  return got.success ? got.data.scripts : null
}

const NOISE = 'Code=4097 "connection to service named com.apple.linkd.autoShortcut"'

function tail(output: string): string {
  return output.split('\n').filter((line) => !line.includes(NOISE)).slice(-TAIL).join('\n')
}

/**
 * A command the cap killed leaves no status, and that is the failure it is recorded as. A program that never
 * started has no output at all, so the spawn error is what the builder reads.
 */
export function npm(args: string[], cwd: string, bin = 'npm', cap = LONG.includes(bin) ? XCODE_CAP : CAP, note?: Note, env?: NodeJS.ProcessEnv): Ran {
  const command = `${bin} ${args.join(' ')}`
  const held = slot(undefined, undefined, undefined, () => note?.('waiting for a check slot', command))
  note?.('checks', command)
  try {
    const done = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: cap, maxBuffer: MAX,
      env: { ...unslotted(), ...env } })
    if (done.error !== undefined && typeof done.stdout !== 'string') return { ok: false, code: '127', output: `${bin}: ${done.error.message}` }
    const output = `${done.stdout}${done.stderr}`
    const capped = (done.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? { capped: true as const } : {}
    return done.status === 0 ? { ok: true, output } : { ok: false, code: String(done.status ?? 1), output, ...capped }
  } finally {
    if (held !== null) free(held)
  }
}

/**
 * The run's own tests must not queue for the slots the run holds, or every test that reaches `npm()` waits until
 * the cap kills the suite.
 */
function unslotted(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CF_CHECK_SLOTS
  delete env.CF_CHECK_SLOTS_DIR
  return env
}

/**
 * Every lane's suite, Swift build and cargo build can run at once, and that load turns slow tests into false
 * failures. The live tick sets `CF_CHECK_SLOTS`; a check waits for one of that many slot files. Unset (tests, a
 * person's shell) means no limit.
 */
export const CHECK_SLOTS = 2

const SLOT_DIR = join(homedir(), '.cf-cache', 'check-slots')

export function slot(dir = process.env.CF_CHECK_SLOTS_DIR ?? SLOT_DIR, n = Number(process.env.CF_CHECK_SLOTS ?? 0),
  wait = 2000, waiting?: () => void): string | null {
  if (!(n > 0)) return null
  mkdirSync(dir, { recursive: true })
  for (let first = true; ; first = false) {
    for (let i = 0; i < n; i += 1) {
      const path = join(dir, `slot-${String(i)}`)
      if (claim(path)) return path
    }
    if (first) waiting?.()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
  }
}

/** A slot whose holder died is cleared for the next claim. */
function claim(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    const holder = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0
    if (holder > 0 && !alive(holder)) rmSync(path, { force: true })
    return false
  }
}

export function free(path: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true })
}
