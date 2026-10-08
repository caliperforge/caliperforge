import { statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../rails/diff.ts'
import { BLOCK } from './learn.ts'
import { diffOf, maybe, srcDir } from './workspace.ts'

const OVERRULED = /\b((?:G\d+[ \t,]*)+)overruled:(?=[ \t]*\S)(.*?)(?=\b(?:G\d+[ \t,]*)+overruled:|$)/gm

/** A finding with no `P<n>` badge stays open, so a change to Greptile's format holds plans rather than passing them. */
export function unruled(root: string, plan: number, sha: string, summary = ''): { found: number; ruled: string[]; open: string[]; refused: string[] } {
  const listed = (maybe(root, plan, `findings-${sha}.md`) ?? '').split(/^(?=- G\d+ )/m)
    .filter((text) => /^- G\d+ /.test(text)).map((text) => ({ id: text.split(' ')[1] ?? '', text }))
  const linked = [...summary.matchAll(/^.*#discussion_r(\d+).*$/gm)].map(([text, n = '']) => ({ id: `G${n}`, text }))
  const findings = [...listed, ...linked].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
  const rank = (f: { text: string }): number => Number(/alt="P(\d)"/.exec(f.text)?.[1] ?? 0)
  const rulings = maybe(root, plan, 'rulings.md') ?? ''
  const accepted = [...rulings.matchAll(BLOCK)].flatMap(([, body = '']) => {
    const field = (key: string): string => new RegExp(`^[ \\t]+${key}:(.*)$`, 'm').exec(body)?.[1]?.trim() ?? ''
    return /^[0-9a-f]{7,40}$/.test(field('head')) && field('reason') !== '' ? field('ids').match(/G\d+/g) ?? [] : []
  })
  const overruled = [rulings, maybe(root, plan, 'issue.md') ?? ''].flatMap((text) => [...text.matchAll(OVERRULED)]
    .flatMap(([, ids = '', reason = '']) => (ids.match(/G\d+/g) ?? []).map((id) => ({ id, reason }))))
  const cites = (reason: string): boolean => [...reason.matchAll(/([^\s`'"(),:]+):\d+/g)].some(([, path = '']) =>
    !path.includes('..') && statSync(join(srcDir(root, plan), path), { throwIfNoEntry: false })?.isFile() === true)
  const ruled = findings.filter((f) => (rank(f) >= 2 && accepted.includes(f.id))
    || overruled.some((o) => o.id === f.id && (rank(f) >= 2 || cites(o.reason))))
  const paths = new Map([...(maybe(root, plan, 'findings.paths') ?? '').matchAll(/^(G\d+) (.+)$/gm)].map(([, id = '', path = '']) => [id, path]))
  const diffed = paths.size === 0 ? [] : parse(diffOf(root, plan)).map((f) => f.path)
  const off = (id: string): boolean => paths.has(id) && !diffed.includes(paths.get(id) ?? '')
  const open = findings.filter((f) => !ruled.includes(f) && !off(f.id) && rank(f) <= 2)
  return { found: findings.length, ruled: ruled.map((f) => f.id), open: open.map((f) => f.id), refused: open.filter((f) => accepted.includes(f.id)).map((f) => f.id) }
}
