import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { npm } from '../sequencer/checks.ts'
import type { Outcome } from '../sequencer/kind.ts'

const LOCKS: [string, string, [string, ...string[]]][] = [['package-lock.json', 'npm', ['ci', '--ignore-scripts', '--include=dev']],
  ['yarn.lock', 'npx', ['yarn@1', 'install', '--frozen-lockfile', '--ignore-scripts']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']]]

const HTTPS = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'git://github.com/' }

export function deps(dir: string): Outcome | null {
  const lock = existsSync(join(dir, 'node_modules')) ? undefined : LOCKS.find(([file]) => existsSync(join(dir, file)))
  if (lock === undefined) return null
  const [, bin, args] = lock
  const first = bin === 'npx' ? yarn(args, dir) : npm(args, dir, bin)
  const ran = first.ok || bin !== 'npx' ? first : yarn(args, dir, HTTPS)
  if (ran.ok) return null
  const lines = ran.output.split('\n')
  const at = lines.findIndex((l) => /^(?:npm (?:error|ERR!)|error )/.test(l))
  const end = lines.findIndex((l, i) => i > at && !/^(?:Exit code|Command|Arguments):/.test(l))
  const block = at < 0 ? '' : lines.slice(at, end < 0 ? undefined : end).join('\n')
  return { outcome: 'refuse', spans: ['bench.install'], note: `${bin} ${args[0]} exited ${ran.code}: ${block}` }
}

/** yarn 1 runs `git pull` in a git dependency's clone it finds in its cache, so each install gets an empty cache. */
function yarn(args: string[], dir: string, env = {}) {
  const cache = mkdtempSync(join(tmpdir(), 'cf-yarn-'))
  try {
    return npm(args, dir, 'npx', undefined, undefined, { ...env, YARN_CACHE_FOLDER: cache })
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}
