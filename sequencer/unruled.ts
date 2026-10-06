import { BLOCK } from './learn.ts'
import { maybe } from './workspace.ts'

const OVERRULED = /^[ \t]*((?:G\d+[ \t,]*)+)overruled:[ \t]*\S/gm

/** A finding with no `P<n>` badge stays open, so a change to Greptile's format holds plans rather than passing them. */
export function unruled(root: string, plan: number, sha: string): { found: number; ruled: string[]; open: string[] } {
  const findings = (maybe(root, plan, `findings-${sha}.md`) ?? '').split(/^(?=- G\d+ )/m)
    .filter((text) => /^- G\d+ /.test(text)).map((text) => ({ id: text.split(' ')[1] ?? '', text }))
  const rulings = maybe(root, plan, 'rulings.md') ?? ''
  const accepted = [...rulings.matchAll(BLOCK)].flatMap(([, body = '']) => {
    const field = (key: string): string => new RegExp(`^[ \\t]+${key}:(.*)$`, 'm').exec(body)?.[1]?.trim() ?? ''
    const head = field('head')
    return /^[0-9a-f]{7,40}$/.test(head) && sha.startsWith(head) && field('reason') !== '' ? field('ids').match(/G\d+/g) ?? [] : []
  })
  const overruled = [rulings, maybe(root, plan, 'issue.md') ?? '']
    .flatMap((text) => [...text.matchAll(OVERRULED)].flatMap(([, ids = '']) => ids.match(/G\d+/g) ?? []))
  const ruled = findings.filter((f) => accepted.includes(f.id) || overruled.includes(f.id))
  const open = findings.filter((f) => !ruled.includes(f) && Number(/alt="P(\d)"/.exec(f.text)?.[1] ?? 0) <= 2)
  return { found: findings.length, ruled: ruled.map((f) => f.id), open: open.map((f) => f.id) }
}
