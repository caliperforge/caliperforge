import { statSync } from 'node:fs'
import { join } from 'node:path'
import { carried } from '../rails/completion-audit/index.ts'
import { parse } from '../rails/diff.ts'
import { BLOCK } from './learn.ts'
import { diffOf, maybe, srcDir } from './workspace.ts'

const OVERRULED = /\b((?:G\d+[ \t,]*)+)overruled:(?=[ \t]*\S)(.*?)(?=\b(?:G\d+[ \t,]*)+overruled:|$)/gm

/** A finding with no `P<n>` badge stays open, so a change to Greptile's format holds plans rather than passing them. */
export function unruled(root: string, plan: number, sha: string, summary = ''): { found: number; ruled: string[]; open: string[]; refused: string[] } {
  const linked = [...summary.matchAll(/^.*#discussion_r(\d+).*$/gm)].map(([text, n = '']) => ({ id: `G${n}`, text }))
  const findings = [...listed(root, plan, sha), ...linked].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
  const rank = (f: { text: string }): number => Number(/alt="P(\d)"/.exec(f.text)?.[1] ?? 0)
  const [ok, over] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan)]
  const cites = (reason: string): boolean => [...reason.matchAll(/([^\s`'"(),:]+):\d+/g)].some(([, path = '']) =>
    !path.includes('..') && statSync(join(srcDir(root, plan), path), { throwIfNoEntry: false })?.isFile() === true)
  const ruled = findings.filter((f) => (rank(f) >= 2 && ok.has(f.id))
    || over.some((o) => o.id === f.id && (rank(f) >= 2 || cites(o.reason))))
  const paths = new Map([...(maybe(root, plan, 'findings.paths') ?? '').matchAll(/^(G\d+) (.+)$/gm)].map(([, id = '', path = '']) => [id, path]))
  const diffed = paths.size === 0 ? [] : parse(diffOf(root, plan)).map((f) => f.path)
  const off = (id: string): boolean => paths.has(id) && !diffed.includes(paths.get(id) ?? '')
  const open = findings.filter((f) => !ruled.includes(f) && !off(f.id) && rank(f) <= 2)
  return { found: findings.length, ruled: ruled.map((f) => f.id), open: open.map((f) => f.id), refused: open.filter((f) => ok.has(f.id)).map((f) => f.id) }
}

export function settled(root: string, plan: number, sha: string): Map<string, string> {
  const [ok, over] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan)]
  const rows = carried(maybe(root, plan, 'step-2.handback.md') ?? '')
  return new Map(listed(root, plan, sha).flatMap(({ id }) => {
    const pointer = typeof rows === 'string' || rows.get(id)?.status !== 'done' ? '' : rows.get(id)?.pointer?.trim() ?? ''
    const line = ok.has(id) ? `accepted: ${ok.get(id) ?? ''}` : over.find((o) => o.id === id)?.line ?? (pointer === '' ? '' : `fixed: ${pointer}`)
    return line === '' ? [] : [[id, line] as const]
  }))
}

function listed(root: string, plan: number, sha: string): { id: string; text: string }[] {
  return (maybe(root, plan, `findings-${sha}.md`) ?? '').split(/^(?=- G\d+ )/m)
    .filter((text) => /^- G\d+ /.test(text)).map((text) => ({ id: text.split(' ')[1] ?? '', text }))
}

function accepted(rulings: string): Map<string, string> {
  const field = (body: string, key: string): string => new RegExp(`^[ \\t]+${key}:(.*)$`, 'm').exec(body)?.[1]?.trim() ?? ''
  return new Map([...rulings.matchAll(BLOCK)].flatMap(([, body = '']) => /^[0-9a-f]{7,40}$/.test(field(body, 'head')) && field(body, 'reason') !== ''
    ? (field(body, 'ids').match(/G\d+/g) ?? []).map((id) => [id, field(body, 'reason')] as const) : []))
}

function overruled(root: string, plan: number): { id: string; reason: string; line: string }[] {
  return [maybe(root, plan, 'rulings.md') ?? '', maybe(root, plan, 'issue.md') ?? ''].flatMap((text) => text.split('\n')).flatMap((line) =>
    [...line.matchAll(OVERRULED)].flatMap(([, ids = '', reason = '']) => (ids.match(/G\d+/g) ?? []).map((id) => ({ id, reason, line: line.trim() }))))
}
