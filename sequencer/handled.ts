import { readdirSync } from 'node:fs'
import { carried } from '../rails/completion-audit/index.ts'
import type { Outcome } from './kind.ts'
import { headOf } from './push.ts'
import { accepted, listed, overruled, unruled } from './unruled.ts'
import { maybe, planDir, put, srcDir, tried } from './workspace.ts'

/** Each Greptile finding at `head` or at a head before it on its line, and each blind finding at `head`'s tree only, with the ruling or the later commit that answers it. */
export function handled(root: string, plan: number, head: string): { id: string; text: string; how: string | null; holds: boolean }[] {
  const [src, reply, pointer] = [srcDir(root, plan), replies(root, plan), pointers(root, plan, true)]
  return [...new Set([...readdirSync(planDir(root, plan)).flatMap((name) => /^findings-([0-9a-f]{40})\.md$/.exec(name)?.[1] ?? []), head])]
    .filter((sha) => tried(src, ['merge-base', '--is-ancestor', sha, head]) !== null)
    .flatMap((sha) => {
      const { open } = unruled(root, plan, sha)
      return listed(root, plan, sha).filter(({ id }) => sha === head || id.startsWith('G')).map(({ id, text }) => {
        const at = pointer(id)
        const fix = at === '' ? '' : tried(src, ['log', '-1', '--format=%H', `${sha}..${head}`, '--', at.split(':')[0] ?? ''])?.trim() ?? ''
        const how = reply(id) ?? (fix === '' ? null : `fixed in ${fix.slice(0, 12)} at ${at}`)
        return { id, text, how, holds: how === null && open.includes(id) }
      })
    })
}

/** A finding at an earlier head holds every later head until a commit or a ruling answers it. */
export function unhandled(root: string, plan: number, bot: Outcome | string): Outcome | string {
  const held = typeof bot === 'string' ? handled(root, plan, headOf(root, plan).sha).filter((f) => f.holds) : []
  return held.length === 0 ? bot : { outcome: 'refuse', spans: ['greptile.unhandled'], to: 2, message: held.map((f) => f.text.trimEnd()).join('\n'),
    note: `${String(held.length)} bot finding(s) on the pull request have neither a fix nor a reply; back to the builder with them` }
}

export function replies(root: string, plan: number): (id: string) => string | undefined {
  const [ok, over] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan)]
  return (id) => ok.has(id) ? `accepted: ${ok.get(id) ?? ''}` : over.find((o) => o.id === id)?.line
}

/** With `folded`, an id the hand-back has no row for is answered by the newest replaced hand-back that had one. */
export function pointers(root: string, plan: number, folded = false): (id: string) => string {
  const [rows, kept] = [carried(maybe(root, plan, 'step-2.handback.md') ?? ''), folded ? fixes(root, plan) : new Map<string, string>()]
  return (id) => {
    const row = typeof rows === 'string' ? undefined : rows.get(id)
    return row === undefined ? kept.get(id) ?? '' : row.status !== 'done' ? '' : row.pointer?.trim() ?? ''
  }
}

const FIXED = 'findings.fixed'

/** A rebuild may leave out a row the hand-back before it called done (`rails/completion-audit/index.ts` `untouched`), so each replaced hand-back's G rows fold in here. */
export function fold(root: string, plan: number, handback: string): void {
  const rows = carried(handback)
  if (typeof rows === 'string') return
  const kept = fixes(root, plan)
  for (const [id, row] of rows) {
    if (!/^G\d+$/.test(id)) continue
    const at = row.status === 'done' ? row.pointer?.trim() ?? '' : ''
    if (at === '') kept.delete(id)
    else kept.set(id, at)
  }
  put(root, plan, FIXED, [...kept].map(([id, at]) => `${id} ${at}\n`).join(''))
}

function fixes(root: string, plan: number): Map<string, string> {
  return new Map([...(maybe(root, plan, FIXED) ?? '').matchAll(/^(G\d+) (.+)$/gm)].map(([, id = '', at = '']) => [id, at]))
}
