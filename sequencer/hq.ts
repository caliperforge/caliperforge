import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import type { Db } from '../store/index.ts'
import { get } from '../store/lanes.ts'
import type { Receipt } from '../store/ticks.ts'
import { said } from './upgrade.ts'

const SECRET = /^(\.env|id_rsa|id_ecdsa|id_ed25519)|\.(pem|key|p12)$/

/** Commits HQ as the host's git identity and pushes whatever its upstream has not got; never forced. */
export function save(dir: string, plans: number[]): string | null {
  const secrets = git(dir, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0')
    .filter((entry) => entry !== '').map((entry) => entry.slice(3)).filter((path) => SECRET.test(basename(path)))
  if (secrets.length > 0) return `hq: refused, ${secrets.join(', ')} not ignored`
  git(dir, ['add', '-A'])
  const staged = git(dir, ['diff', '--cached', '--name-only']).trim() !== ''
  if (staged) git(dir, ['commit', '-qm', `hq: ${plans.length === 1 ? 'plan' : 'plans'} ${plans.join(', ')}`])
  if (!ahead(dir)) return staged ? `hq: committed ${head(dir)}` : null
  try {
    git(dir, ['push'])
  } catch (error) {
    return `hq: push failed: ${said(error)}`
  }
  return `hq: pushed ${head(dir)}`
}

export function saved(db: Db, lap: Receipt, plans: number[]): Receipt {
  if (plans.length === 0) return lap
  const dir = get(db, 'hq.path')
  if (dir === '') return lap
  const note = save(dir, plans)
  return note === null ? lap : { ...lap, note: `${lap.note}; ${note}` }
}

function ahead(dir: string): boolean {
  try {
    return Number(git(dir, ['rev-list', '--count', '@{u}..HEAD'])) > 0
  } catch {
    return false
  }
}

function head(dir: string): string {
  return git(dir, ['rev-parse', '--short', 'HEAD']).trim()
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}
