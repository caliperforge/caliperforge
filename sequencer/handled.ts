import { readdirSync } from 'node:fs'
import { carried } from '../rails/completion-audit/index.ts'
import type { Outcome } from './kind.ts'
import { headOf } from './push.ts'
import { accepted, listed, overruled, unruled } from './unruled.ts'
import { maybe, planDir, srcDir, tried } from './workspace.ts'

/** Each finding at `head` or at a head before it on its line, with the ruling or the later commit that answers it. */
export function handled(root: string, plan: number, head: string): { id: string; text: string; how: string | null; holds: boolean }[] {
  const [src, reply, pointer] = [srcDir(root, plan), replies(root, plan), pointers(root, plan, ['step-2.handback.md', 'step-2.handback.prev.md'])]
  return readdirSync(planDir(root, plan)).flatMap((name) => /^findings-([0-9a-f]{40})\.md$/.exec(name)?.[1] ?? [])
    .filter((sha) => tried(src, ['merge-base', '--is-ancestor', sha, head]) !== null)
    .flatMap((sha) => {
      const { open } = unruled(root, plan, sha)
      return listed(root, plan, sha).map(({ id, text }) => {
        const at = pointer(id)
        const fix = at === '' ? '' : tried(src, ['log', '-1', '--format=%H', `${sha}..${head}`, '--', at.split(':')[0] ?? ''])?.trim() ?? ''
        const how = reply(id) ?? (fix === '' ? null : `fixed in ${fix.slice(0, 12)} at ${at}`)
        return { id, text, how, holds: how === null && open.includes(id) }
      })
    })
}

/** Greptile is asked once, so a finding at an earlier head holds every head after it until a commit or a ruling answers it. */
export function unhandled(root: string, plan: number, bot: Outcome | string): Outcome | string {
  const held = typeof bot === 'string' ? handled(root, plan, headOf(root, plan).sha).filter((f) => f.holds) : []
  return held.length === 0 ? bot : { outcome: 'refuse', spans: ['greptile.unhandled'], to: 2, message: held.map((f) => f.text.trimEnd()).join('\n'),
    note: `${String(held.length)} bot finding(s) on the pull request have neither a fix nor a reply; back to the builder with them` }
}

export function replies(root: string, plan: number): (id: string) => string | undefined {
  const [ok, over] = [accepted(maybe(root, plan, 'rulings.md') ?? ''), overruled(root, plan)]
  return (id) => ok.has(id) ? `accepted: ${ok.get(id) ?? ''}` : over.find((o) => o.id === id)?.line
}

/** The first hand-back with a row for the id answers it: a rebuild may leave out a row the one before it called done (`rails/completion-audit/index.ts` `untouched`). */
export function pointers(root: string, plan: number, kept = ['step-2.handback.md']): (id: string) => string {
  const all = kept.flatMap((name) => { const rows = carried(maybe(root, plan, name) ?? ''); return typeof rows === 'string' ? [] : [rows] })
  return (id) => { const row = all.find((rows) => rows.has(id))?.get(id); return row?.status !== 'done' ? '' : row.pointer?.trim() ?? '' }
}
