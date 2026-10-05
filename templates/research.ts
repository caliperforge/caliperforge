import { z } from 'zod'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { put } from '../sequencer/workspace.ts'
import type { PlanRow } from '../store/plans.ts'

const FENCE = /(?:^|\n)---\n(sources:.*\n(?:[ \t-].*\n)*)---\s*$/

const Sources = z.object({
  sources: z.array(z.object({
    url: z.string().trim().min(1),
    fetched_at: z.string(),
    quote: z.string().nullish(),
    claim: z.string(),
  })),
})

export function sourced(root: string, plan: PlanRow, reply: string): Outcome {
  const fence = FENCE.exec(reply)
  const got = Sources.safeParse(fence === null ? null : prose(fence[1] ?? '', ['fetched_at', 'quote', 'claim']))
  if (!got.success) return { outcome: 'refuse', spans: ['researcher.fence'], note: 'researcher reply has no valid sources fence' }
  const unquoted = got.data.sources.filter((s) => (s.quote ?? '').trim() === '').map((s) => s.url)
  if (unquoted.length > 0) return { outcome: 'refuse', spans: ['researcher.unquoted'], note: `no quote for ${unquoted.join(', ')}` }
  put(root, plan.id, 'sources.json', JSON.stringify(got.data.sources))
  return { outcome: 'pass', spans: [], note: `sources.json written with ${String(got.data.sources.length)} source(s)` }
}
