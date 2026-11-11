import { statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../rails/diff.ts'
import { pointers, replies } from './handled.ts'
import { BLOCK } from './learn.ts'
import { answered, badge, listed } from './listed.ts'
import { diffOf, maybe, srcDir } from './workspace.ts'

export { listed }

const OVERRULED = /\b((?:[GB]\d+[ \t,]*)+)overruled:(?=[ \t]*\S)(.*?)(?=\b(?:[GB]\d+[ \t,]*)+overruled:|$)/gm

/** A finding with no `P<n>` badge stays open, so a change to Greptile's format holds plans rather than passing them. */
export function unruled(root: string, plan: number, sha: string, summary = '', of = /^[GB]/): { found: number; ruled: string[]; open: string[]; refused: string[]; severe: string[] } {
  const linked = [...summary.matchAll(/^.*#discussion_r(\d+).*$/gm)].map(([text, n = '']) => ({ id: `G${n}`, rank: badge(text), text }))
  const findings = [...listed(root, plan, sha), ...linked].filter((f, i, all) => of.test(f.id) && all.findIndex((g) => g.id === f.id) === i)
  const [ok, over, said] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan), answered(root, plan)]
  const cites = (reason: string): boolean => [...reason.matchAll(/([^\s`'"(),:]+):\d+/g)].some(([, path = '']) =>
    !path.includes('..') && statSync(join(srcDir(root, plan), path), { throwIfNoEntry: false })?.isFile() === true)
  const ruled = findings.filter((f) => (f.rank >= 2 && ok.has(f.id))
    || over.some((o) => o.id === f.id && (f.rank >= 2 || cites(o.reason))))
  const paths = new Map([...(maybe(root, plan, 'findings.paths') ?? '').matchAll(/^(G\d+) (.+)$/gm)].map(([, id = '', path = '']) => [id, path]))
  const diffed = paths.size === 0 ? [] : parse(diffOf(root, plan)).map((f) => f.path)
  const off = (id: string): boolean => paths.has(id) && !diffed.includes(paths.get(id) ?? '')
  const open = findings.filter((f) => !ruled.includes(f) && !off(f.id) && !said.has(f.id) && f.rank <= 2)
  return { found: findings.length, ruled: ruled.map((f) => f.id), open: open.map((f) => f.id), refused: open.filter((f) => ok.has(f.id)).map((f) => f.id), severe: open.filter((f) => f.rank <= 1).map((f) => f.id) }
}

export function settled(root: string, plan: number, sha: string): Map<string, string> {
  const [reply, said, pointer] = [replies(root, plan), answered(root, plan), pointers(root, plan)]
  return new Map(listed(root, plan, sha).flatMap(({ id }) => {
    const line = reply(id) ?? said.get(id) ?? (pointer(id) === '' ? '' : `fixed: ${pointer(id)}`)
    return line === '' ? [] : [[id, line] as const]
  }))
}

export const field = (body: string, key: string): string => new RegExp(`^[ \\t]+${key}:(.*)$`, 'm').exec(body)?.[1]?.trim() ?? ''

export function accepted(rulings: string): Map<string, string> {
  return new Map([...rulings.matchAll(BLOCK)].flatMap(([, body = '']) => /^[0-9a-f]{7,40}$/.test(field(body, 'head')) && field(body, 'reason') !== ''
    ? (field(body, 'ids').match(/[GB]\d+/g) ?? []).map((id) => [id, field(body, 'reason')] as const) : []))
}

export function overruled(root: string, plan: number): { id: string; reason: string; line: string }[] {
  return [maybe(root, plan, 'rulings.md') ?? '', maybe(root, plan, 'issue.md') ?? ''].flatMap((text) => text.split('\n')).flatMap((line) =>
    [...line.matchAll(OVERRULED)].flatMap(([, ids = '', reason = '']) => (ids.match(/[GB]\d+/g) ?? []).map((id) => ({ id, reason, line: line.trim() }))))
}
