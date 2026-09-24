import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Package = z.object({ scripts: z.record(z.string(), z.string()).default({}) })

/** The script names `package.json:13` reads, in the order a checkout is judged in. */
const SCRIPTS = ['typecheck', 'lint', 'test']

const TAIL = 80

const CAP = 10 * 60 * 1000

/** A cold Xcode build of the whole app and its tests runs well past the npm cap. */
const XCODE_CAP = 25 * 60 * 1000

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

/** #126: what a checkout is judged with, by what sits at its root. */
export type Mode = 'xcodebuild' | 'npm' | 'gradle' | 'none'

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
export function checks(src: string, run: Run = npm, narrow: string[] = []): Failure | null {
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

function loadOnly(output: string): boolean {
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

/** A command the cap killed leaves no status, and that is the failure it is recorded as. */
function npm(args: string[], cwd: string, bin = 'npm'): { code: number; output: string } {
  const done = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: bin === 'xcodebuild' ? XCODE_CAP : CAP, maxBuffer: MAX })
  return { code: done.status ?? 1, output: `${done.stdout}${done.stderr}` }
}
