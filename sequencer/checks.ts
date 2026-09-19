import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Package = z.object({ scripts: z.record(z.string(), z.string()).default({}) })

/** The script names `package.json:13` reads, in the order a checkout is judged in. */
const SCRIPTS = ['typecheck', 'lint', 'test']

const TAIL = 80

const CAP = 10 * 60 * 1000

const MAX = 64 * 1024 * 1024

export interface Failure {
  command: string
  code: number
  output: string
}

export type Run = (args: string[], cwd: string) => { code: number; output: string }

export function checks(src: string, run: Run = npm): Failure | null {
  for (const args of commands(src)) {
    const { code, output } = run(args, src)
    if (code !== 0) return { command: `npm ${args.join(' ')}`, code, output: tail(output) }
  }
  return null
}

function commands(src: string): string[][] {
  const scripts = named(src)
  if (scripts === null) return []
  const install = existsSync(join(src, 'package-lock.json')) && !existsSync(join(src, 'node_modules'))
  return [...(install ? [['ci']] : []), ...scripts.map((s) => ['run', s])]
}

function named(src: string): string[] | null {
  const path = join(src, 'package.json')
  if (!existsSync(path)) return null
  const read = Package.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!read.success) return null
  return SCRIPTS.filter((s) => read.data.scripts[s] !== undefined)
}

function tail(output: string): string {
  return output.split('\n').slice(-TAIL).join('\n')
}

/** A command the cap killed leaves no status, and that is the failure it is recorded as. */
function npm(args: string[], cwd: string): { code: number; output: string } {
  const done = spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: CAP, maxBuffer: MAX })
  return { code: done.status ?? 1, output: `${done.stdout}${done.stderr}` }
}
