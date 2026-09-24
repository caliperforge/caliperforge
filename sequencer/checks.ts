import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { gates, type Gate, type Outside, type OutsideLanguage } from './gates.ts'

const Package = z.object({ scripts: z.record(z.string(), z.string()).default({}) })

/** The script names `package.json:13` reads, in the order a checkout is judged in. */
const SCRIPTS = ['typecheck', 'lint', 'test']

const TAIL = 80

const CAP = 10 * 60 * 1000

/** A cold Xcode build of the whole app and its tests runs well past the npm cap; so does a cold cargo build. */
const XCODE_CAP = 25 * 60 * 1000

const LONG = ['xcodebuild', 'cargo']

const MAX = 64 * 1024 * 1024

export interface Failure {
  /** The script the failure is named by, whatever command stood in for it. */
  script: string
  command: string
  code: number
  output: string
  retried: boolean
}

/** `bin` is the program; left out it is `npm`, which is every checkout but an Xcode or a Kotlin one. */
export type Run = (args: string[], cwd: string, bin?: string) => { code: number; output: string }

/** #126: what a checkout is judged with, by what sits at its root; #204: an outside plan, by its language. */
export type Mode = 'xcodebuild' | 'npm' | 'gradle' | 'none' | OutsideLanguage

/** Derived data stays inside the checkout, under `.cf/work`, and never under a folder macOS guards. */
export const DERIVED = '.cf-derived'

const XCODE = (project: string): string[] => ['-project', project, '-scheme', project.replace(/\.xcodeproj$/, ''),
  '-destination', 'platform=macOS', '-derivedDataPath', DERIVED, 'test']

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
 * `narrow` is the plan's own file list (#77). Given one, the tests run is `vitest related` over those
 * paths -- every test the import graph says they can reach -- instead of the whole suite. The first pass
 * through step 3 passes none, so every job still runs the suite whole once, against the tree it built on.
 */
export function checks(src: string, run: Run = npm, narrow: string[] = [], outside: Outside | null = null): Failure | null {
  if (outside !== null) return gated(src, gates(src, outside), run)
  const bin = mode(src)
  if (bin === 'xcodebuild') excluded(src)
  for (const [script, args] of commands(src, narrow)) {
    const first = run(args, src, bin)
    if (first.code === 0) continue
    const retried = loadOnly(first.output)
    const { code, output } = retried ? run(args, src, bin) : first
    if (code !== 0) return { script, command: `${bin} ${args.join(' ')}`, code, output: tail(output), retried }
  }
  return null
}

/**
 * #204: a stranger's repo in a language with its own seat runs that language's gates in the language's own folder.
 * A gate marked `quiet` fails on any output, as `gofmt -l` exits zero and prints the files it would change.
 */
function gated(src: string, list: Gate[], run: Run): Failure | null {
  for (const gate of list) {
    const cwd = join(src, gate.dir)
    const where = gate.dir === '' ? '' : ` (in ${gate.dir}/)`
    const first = settled(gate, run(gate.args, cwd, gate.bin))
    if (first.code === 0) continue
    return { script: gate.script, command: `${gate.bin} ${gate.args.join(' ')}${where}`, code: first.code, output: tail(first.output), retried: false }
  }
  return null
}

function settled(gate: Gate, ran: { code: number; output: string }): { code: number; output: string } {
  return gate.quiet === true && ran.code === 0 && ran.output.trim() !== '' ? { code: 1, output: ran.output } : ran
}

/** The derived data is build output: never staged, never in the diff the reviewers read. */
export function excluded(src: string): void {
  const path = join(src, '.git', 'info', 'exclude')
  if (!existsSync(join(src, '.git'))) return
  const held = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (!held.split('\n').includes(`${DERIVED}/`)) appendFileSync(path, `${held.endsWith('\n') || held === '' ? '' : '\n'}${DERIVED}/\n`)
}

/** vitest names a failed test where it ran it and again under Failed Tests; each naming opens a block. */
const OPENS = /^[ \t]*(?:FAIL\b|×[ \t])/

const LOAD = /Test timed out in \d+ *ms|Hook timed out|expected [\d.]+ to be less than [\d.]+/

/** xcodebuild's runner never connected, so no test ran and nothing else can have failed. */
const HUNG = 'The test runner hung before establishing connection'

function loadOnly(output: string): boolean {
  if (output.includes(HUNG)) return true
  const named = failures(output)
  return named.length > 0 && named.every((block) => LOAD.test(block))
}

export function failures(output: string): string[] {
  const blocks: string[][] = []
  for (const line of output.split('\n')) {
    if (OPENS.test(line)) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }
  return blocks.map((block) => block.join('\n'))
}

/** A test script that is vitest takes `related`; anything else is run whole, narrow list or not. */
const VITEST = /(^|\s)vitest(\s|$)/

function commands(src: string, narrow: string[]): [string, string[]][] {
  const xcode = project(src)
  if (xcode !== null) return [['test', XCODE(xcode)]]
  if (mode(src) === 'gradle') return [['check', GRADLE]]
  const scripts = read(src)
  if (scripts === null) return []
  const named = SCRIPTS.filter((s) => scripts[s] !== undefined)
  return [
    ...(bare(src) ? [['ci', ['ci']] as [string, string[]]] : []),
    ...named.map((s): [string, string[]] => [s, related(scripts[s] ?? '', s, narrow) ?? ['run', s]]),
  ]
}

function related(script: string, name: string, narrow: string[]): string[] | null {
  if (name !== 'test' || narrow.length === 0 || !VITEST.test(script)) return null
  return ['exec', '--', 'vitest', 'related', '--run', ...narrow]
}

function bare(src: string): boolean {
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

function tail(output: string): string {
  return output.split('\n').slice(-TAIL).join('\n')
}

/**
 * A command the cap killed leaves no status, and that is the failure it is recorded as. A program that never
 * started has no output at all, so the spawn error is what the builder reads (09-24: cargo off launchd's PATH).
 */
export function npm(args: string[], cwd: string, bin = 'npm'): { code: number; output: string } {
  const done = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: LONG.includes(bin) ? XCODE_CAP : CAP, maxBuffer: MAX })
  if (done.error !== undefined && typeof done.stdout !== 'string') return { code: 127, output: `${bin}: ${done.error.message}` }
  return { code: done.status ?? 1, output: `${done.stdout}${done.stderr}` }
}
