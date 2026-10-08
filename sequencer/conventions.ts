import { basename } from 'node:path'
import type { Check, Row } from './card.ts'
import { git, MAIN, srcDir } from './workspace.ts'

export const CONVENTIONAL = /^[a-z]+(\([^)]*\))?!?: /
const SIGNED = /^Signed-off-by: /m
const CHANGELOG = /^change(s|log)\b/i

const most = (list: string[], test: RegExp): boolean => list.filter((s) => test.test(s)).length > list.length / 2
const subjectOf = (body: string): string => body.split('\n')[0] ?? ''

export function conventions(...[, root, plan]: Parameters<Check>): Row {
  return conform(srcDir(root, plan))
}

export function conform(dir: string): Row {
  const last = ['-n', '20', MAIN]
  const mine = [`${MAIN}..HEAD`]
  const recent = bodies(dir, last)
  const ours = bodies(dir, mine)
  const changelog = touched(dir, last) && !touched(dir, mine) ? ['no commit of ours touches the changelog'] : []
  const misses = [...subjects(recent, ours), ...signoffs(recent, ours), ...changelog]
  if (misses.length > 0) return { check: 'conventions', ok: false, says: misses.join('; ') }
  return { check: 'conventions', ok: true, says: `matches the last ${String(recent.length)} commits` }
}

function bodies(dir: string, range: string[]): string[] {
  return git(dir, ['log', '--no-merges', '--format=%B%x00', ...range]).split('\0').map((b) => b.trim()).filter((b) => b !== '')
}

function touched(dir: string, range: string[]): boolean {
  return git(dir, ['log', '--no-merges', '--name-only', '--format=', ...range]).split('\n').some((p) => CHANGELOG.test(basename(p)))
}

function subjects(recent: string[], ours: string[]): string[] {
  const shaped = most(recent.map(subjectOf), CONVENTIONAL)
  const [mine, theirs] = shaped ? ['plain', 'conventional'] : ['conventional', 'plain']
  return ours.map(subjectOf).filter((s) => CONVENTIONAL.test(s) !== shaped)
    .map((s) => `subject "${s}" is ${mine}, the repo's are ${theirs}`)
}

function signoffs(recent: string[], ours: string[]): string[] {
  if (!most(recent, SIGNED)) return []
  return ours.filter((b) => !SIGNED.test(b)).map((b) => `"${subjectOf(b)}" has no Signed-off-by`)
}
