import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { npm } from '../sequencer/checks.ts'
import type { Outcome } from '../sequencer/kind.ts'

const LOCKS: [string, string, [string, ...string[]]][] = [['package-lock.json', 'npm', ['ci', '--ignore-scripts', '--include=dev']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']]]

export function deps(dir: string): Outcome | null {
  const lock = existsSync(join(dir, 'node_modules')) ? undefined : LOCKS.find(([file]) => existsSync(join(dir, file)))
  if (lock === undefined) return null
  const [, bin, args] = lock
  const ran = npm(args, dir, bin)
  if (ran.ok) return null
  const line = ran.output.split('\n').find((l) => /^(?:npm (?:error|ERR!)|error )/.test(l)) ?? ''
  return { outcome: 'refuse', spans: ['bench.install'], note: `${bin} ${args[0]} exited ${ran.code}: ${line}` }
}
