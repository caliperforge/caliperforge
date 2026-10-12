import { readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { walk } from '../checks/tree.ts'
import { run, WINDOW, type Read, type Run } from '../cli/gh.ts'
import { notify, record, type Event } from '../cli/inbox.ts'
import type { Provider } from '../providers/kind.ts'
import { read as verdict } from '../reviews/verdict.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { pipesOn } from '../store/capture.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { LANE, wall } from '../store/lanes.ts'
import { FIELDS, Listed, type Listing } from '../store/tickets.ts'
import { pending } from '../store/transcript.ts'
import { lastLogged } from '../store/wave.ts'
import { design } from './design.ts'
import { firstLine } from './unpolled.ts'

const WAVE = /^wave:(\d+)$/

const INBOX = { pass: 'wave', refuse: 'refused', needs_ceo: 'blocked' } as const

function waveOf(labels: Listing['labels']): number | undefined {
  const hit = labels.map((l) => WAVE.exec(l.name)?.[1]).find((n) => n !== undefined)
  return hit === undefined ? undefined : Number(hit)
}

export function waits(db: Db, repo: string, labels: Listing['labels']): boolean {
  const n = waveOf(labels)
  return repo === LANE.atelier.home && n !== undefined && n > 1 && lastLogged(db, 'wave', `wave ${String(n - 1)}`)?.outcome !== 'pass'
}

export async function closing(db: Db, root: string, provider: Provider, read: Read, now: Date,
  web = join(homedir(), 'atelier_web'), exec: Run = run): Promise<string[]> {
  if (!pipesOn(db).has(LANE.atelier.pipe)) return []
  try {
    const filed = first(read, exec)
    const n = closed(db, read)
    return n === undefined ? filed : [...filed, await pass(db, root, provider, now, web, n)]
  } catch (error) {
    const line = `wave: ${firstLine(error)}`
    logged(db, { plan: null, kind: 'swallowed', actor: 'wave', outcome: 'pass', message: line, pointer: null, run: null })
    return [line]
  }
}

/** The lowest wave whose tickets are all closed and that has had no pass since the last of them closed. */
function closed(db: Db, read: Read): number | undefined {
  const tickets = listed(read)
  if (tickets === undefined) return undefined
  const waves = [...new Set(tickets.map((i) => waveOf(i.labels)).filter((n) => n !== undefined))].sort((a, b) => a - b)
  return waves.find((n) => {
    const closes = tickets.filter((i) => waveOf(i.labels) === n).map((i) => i.closedAt)
    const shut = closes.filter((c) => c !== null)
    const last = lastLogged(db, 'wave', `wave ${String(n)}`)
    return shut.length === closes.length && (last === undefined || Date.parse(last.at) < Math.max(...shut.map((c) => Date.parse(c))))
  })
}

function listed(read: Read): Listing[] | undefined {
  const list = (state: string): Listing[] => Listed.parse(read(['issue', 'list', '--repo', LANE.atelier.home, '--state', state,
    '--limit', String(WINDOW), '--json', FIELDS]))
  const lists = [list('open'), list('closed')]
  return lists.some((l) => l.length >= WINDOW) ? undefined : lists.flat()
}

const Contents = z.array(z.object({ path: z.string() }))

const File = z.object({ content: z.string() })

const HEADING = /^#{1,6} (.+)$/

const Numbers = z.array(z.object({ number: z.int() }))

const TITLE = 'Design lead\'s first pass: DESIGN.md, the audit, wave 1'

const BODY = ['**What:** write `DESIGN.md` with a section auditing every page against the rev-2 canvas, and draft the wave 1 tickets under `design/tickets/`, one file per ticket',
  '**Why:** main has no `DESIGN.md`, and the design lead fires only when a wave closes',
  '**When it ends:** `DESIGN.md` and its audit are on main, with one file per wave 1 ticket under `design/tickets/`', ''].join('\n')

function first(read: Read, exec: Run): string[] {
  const home = LANE.atelier.home
  if (Contents.parse(read(['api', `repos/${home}/contents?ref=main`])).some((e) => e.path === 'DESIGN.md')) return drafts(read, exec)
  if (Numbers.parse(read(['issue', 'list', '--repo', home, '--label', 'seat:design_lead', '--state', 'all', '--json', 'number'])).length > 0) return []
  exec(['label', 'create', 'seat:design_lead', '--repo', home, '--force'])
  const url = exec(['issue', 'create', '--repo', home, '--title', TITLE, '--body-file', '-', '--label', 'lane:atelier', '--label', 'seat:design_lead'], BODY)
  return [`first pass: ${url.trim()}`]
}

function drafts(read: Read, exec: Run): string[] {
  const home = LANE.atelier.home
  if (Numbers.parse(read(['issue', 'list', '--repo', home, '--label', 'seat:design_lead', '--state', 'closed', '--json', 'number'])).length === 0) return []
  const tickets = listed(read)
  if (tickets === undefined || tickets.some((i) => waveOf(i.labels) !== undefined)) return []
  const paths = Contents.parse(read(['api', `repos/${home}/contents/design/tickets?ref=main`])).map((e) => e.path).filter((p) => p.endsWith('.md')).sort()
  const sections = text(read, 'DESIGN.md').split('\n').flatMap((l) => HEADING.exec(l)?.[1]?.trim() ?? [])
  const found = paths.map((path) => ({ path, lines: text(read, path).split('\n') }))
  const cites = (lines: string[]): boolean => lines.some((l) => l.includes('DESIGN.md') && sections.some((s) => l.includes(s)))
  if (found.some((d) => cites(d.lines))) exec(['label', 'create', 'wave:1', '--repo', home, '--force'])
  return found.map(({ path, lines }) => {
    if (!cites(lines)) return `wave 1: ${path} cites no DESIGN.md section`
    const [head = '', ...rest] = lines
    const url = exec(['issue', 'create', '--repo', home, '--title', head.replace(/^# /, ''), '--body-file', '-', '--label', 'lane:atelier',
      '--label', 'wave:1'], rest.join('\n').trim())
    return `wave 1: ${url.trim()}`
  })
}

function text(read: Read, path: string): string {
  const file = File.parse(read(['api', `repos/${LANE.atelier.home}/contents/${path}?ref=main`]))
  return Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

async function pass(db: Db, root: string, provider: Provider, now: Date, web: string, n: number): Promise<string> {
  const out = join(root, '.cf/waves', String(n))
  rmSync(out, { recursive: true, force: true })
  const shot = await design(web, out, walk(web, (f) => f.endsWith('.html')).map((p) => relative(web, p)))
  const dir = join(out, 'design')
  const pngs = readdirSync(dir).sort()
  load(db, root)
  const { manifest, prompt } = seat(root, 'design_lead')
  const built = packet(manifest, prompt, tight(root), ask(n, pngs.map((p) => join(dir, p)), shot.spans), web, pending(out, 'design_lead'), false, [])
  const fired = await provider.fire({ ...built, reads: [dir], wall: wall(db) })
  const judged = fired.ended === 'completed' ? verdict(fired.text, pngs.join('\n')) : null
  const spans = [...shot.spans, ...(judged?.spans ?? [])]
  const outcome = judged === null ? 'needs_ceo' : spans.length > 0 ? 'refuse' : judged.outcome
  const said = `wave ${String(n)} ${outcome}${judged === null ? ': no verdict' : spans.length > 0 ? `: ${spans.join('; ')}` : ''}`
  logged(db, { plan: null, kind: 'wave', actor: 'design_lead', outcome, message: said, pointer: `wave ${String(n)}`, run: null }, now.toISOString())
  const event: Event = { at: now.toISOString(), plan: 0, ticket: `wave ${String(n)}`, kind: INBOX[outcome], step: 0, name: 'design_lead',
    note: `${said}. ${dir}: ${pngs.join(', ')}` }
  record(root, [event])
  notify([event])
  return said
}

function ask(n: number, screenshots: string[], spans: string[]): string {
  return `Every \`wave:${String(n)}\` ticket on ${LANE.atelier.home} is closed. Judge the whole app in these screenshots against \`DESIGN.md\`: does every page show the same job, status, number, person or time the same way? Write no file.

# Screenshots

${screenshots.map((s) => `- ${s}`).join('\n')}

# Hard defects the capture found

${spans.length === 0 ? 'none' : spans.map((s) => `- ${s}`).join('\n')}

# Verdict

Close with this fence and nothing after it; a refuse names a snake_case \`class\` and one span per drift.

---
outcome: pass | refuse | needs_ceo
class: <on a refuse>
spans:
  - "<page>: <what drifts, on a refuse>"
---`
}
