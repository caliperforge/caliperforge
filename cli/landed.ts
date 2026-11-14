import { covered } from '../sequencer/covered.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { Holder } from '../store/plans.ts'
import { gh, type Read } from './gh.ts'
import { add, type Filed, issue, parse } from './plan.ts'

export function guarded(db: Db, root: string, ask: { issue: string; pipe?: string; overLanded?: boolean; why?: string }, by: Holder,
  read: Read = gh): Filed {
  if (ask.overLanded === true && ask.why === undefined) throw new Error('--over-landed takes --why')
  const { repo, no } = parse(ask.issue)
  const row = issue(repo, no, read)
  const cover = covered(db, root, null, repo, row.title, row.body, new Date(), read)
  if (cover.verdict !== 'landed') return add(db, root, ask.issue, by, ask.pipe, read)
  if (ask.overLanded !== true) {
    const why = `#${String(no)} looks landed as ${cover.sha} (#${String(cover.no)}); cf plan add --issue ${ask.issue} --over-landed --why <text> to queue it anyway`
    logged(db, { plan: null, kind: 'covered', actor: by, outcome: 'refuse', message: why, pointer: cover.url, run: null })
    return { plan: null, lane: null, seat: null, state: 'refused', why, origin: null, ruling: null }
  }
  const filed = add(db, root, ask.issue, by, ask.pipe, read)
  logged(db, { plan: filed.plan, kind: 'covered', actor: by, outcome: 'pass',
    message: `queued over #${String(cover.no)} landed as ${cover.sha}: ${String(ask.why)}`, pointer: cover.url, run: null })
  return filed
}
