import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { migrate, type Db } from '../store/index.ts'
import type { Receipt } from '../store/ticks.ts'
import { SELF } from './workspace.ts'

const COMMIT = `https://github.com/${SELF}/commit/`

/** `land()` writes this url; a target's push writes a pull request one, and no landing of ours is in it. */
function landed(db: Db): string | null {
  const row = db.prepare(`SELECT evidence FROM deliverables WHERE state = 'pushed' AND evidence LIKE ?
    ORDER BY id DESC LIMIT 1`).get(`${COMMIT}%`) as { evidence: string } | undefined
  return row === undefined ? null : row.evidence.slice(COMMIT.length)
}

/** The landed sha the live tree at `root` has not got, off its own refs: no fetch, no network. */
export function behind(db: Db, root: string): string | null {
  const sha = landed(db)
  if (sha === null) return null
  try {
    git(root, ['merge-base', '--is-ancestor', sha, 'HEAD'])
    return null
  } catch {
    return sha
  }
}

/** `--ff-only` refuses before it touches a ref, so a tree carrying a commit of its own runs no schema file either. */
export function upgrade(db: Db, root: string, sha: string): string | null {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  try {
    if (branch === 'HEAD') forward(root)
    else git(root, ['pull', '--ff-only'])
  } catch (error) {
    return `${branch} cannot fast-forward to ${sha.slice(0, 12)}: ${said(error)}`
  }
  try {
    migrate(db, join(root, 'schema'))
  } catch (error) {
    return `migrate to ${sha.slice(0, 12)}: ${said(error)}`
  }
  return null
}

/** The lap's receipt once the tree holds what the lap landed, so the row written last carries the refusal. */
export function upgraded(db: Db, root: string, lap: Receipt): Receipt {
  const sha = behind(db, root)
  if (sha === null) return lap
  const reason = upgrade(db, root, sha)
  return reason === null ? lap : { ...lap, exit: 1, note: `${lap.note}; ${reason}` }
}

/**
 * #337. The pinned tick tree (#168) sits on a detached HEAD, where `git pull` has no branch to pull. It moves the
 * way tick.sh moves it: to origin/main, and only forward.
 */
function forward(root: string): void {
  git(root, ['fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  git(root, ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'])
  git(root, ['checkout', '-q', '--detach', 'refs/remotes/origin/main'])
}

export function said(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim().split('\n').at(-1)?.trim() ?? ''
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
