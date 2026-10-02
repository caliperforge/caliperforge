import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Gate } from './gates.ts'

export const Package = z.object({ scripts: z.record(z.string(), z.string()).default({}) })

const LOCKS: Record<string, Omit<Gate, 'dir'>> = {
  'pnpm-lock.yaml': { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'] },
  'package-lock.json': { script: 'install', bin: 'npm', args: ['ci'] },
}

export function lockfile(name: string): boolean {
  return name in LOCKS
}

/** Install at `at`, the nearest lockfile's folder, a workspace's root; then the scripts `package.json` defines, run by that lockfile's manager. */
export function nodeGates(src: string, dir: string, at: string, scripts: string[]): { install: Gate[]; raw: Gate[] } {
  const lock = Object.entries(LOCKS).find(([name]) => existsSync(join(src, at, name)))?.[1]
  const bin = lock?.bin ?? 'npm'
  const path = join(src, dir, 'package.json')
  const got = existsSync(path) ? Package.safeParse(JSON.parse(readFileSync(path, 'utf8'))) : null
  const defined = got?.success === true ? got.data.scripts : {}
  return {
    install: lock === undefined ? [] : [{ ...lock, dir: at }],
    raw: scripts.filter((s) => defined[s] !== undefined).map((s) => ({ script: s, bin, args: ['run', s], dir })),
  }
}
