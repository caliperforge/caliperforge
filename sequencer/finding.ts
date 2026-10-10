import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, registered, seat, tight } from '../runner/rules.ts'
import { closeFinding, type Finding, unanswered } from '../store/drift.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { pending } from '../store/transcript.ts'
import { applying, spare } from './director.ts'
import { prose } from './prose.ts'
import { WIRE, type Wire } from './push.ts'
import { SELF } from './workspace.ts'

const Said = z.object({
  outcome: z.enum(['fixed', 'covered', 'retire', 'defect']),
  why: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).transform((t) => t.slice(0, 140)).optional(),
  files: z.string().trim().min(1).optional(),
  ends: z.string().trim().min(1).optional(),
}).strict().refine((m) => m.outcome !== 'covered' || m.ref !== undefined, { path: ['ref'] })
  .refine((m) => m.outcome !== 'defect' || (m.title !== undefined && m.files !== undefined && m.ends !== undefined), { path: ['title'] })

type Said = z.infer<typeof Said>

interface Entry { from: number; to: number }

export async function answer(db: Db, root: string, provider: Provider, now: Date, wire: Wire = WIRE): Promise<string> {
  if (!applying(db)) return 'director.apply is off'
  const [found] = unanswered(db, now)
  if (found === undefined) return 'no open finding'
  const busied = spare(db, now)
  if (busied !== null) return busied
  load(db, root)
  const { manifest, prompt } = seat(root, 'director')
  const dir = join(root, '.cf/drift')
  mkdirSync(dir, { recursive: true })
  const held = holder(root, found.name)
  const text = `# Finding\n\n${line(found)}, found ${found.found_at}\n\n# Registry entry\n\n${
    held === null ? 'none' : held.lines.slice(held.at.from, held.at.to).join('\n')}`
  const built = packet(manifest, prompt, tight(root), text, dir, pending(dir, `finding-${String(found.id)}`))
  const fired = await provider.fire({ ...built, wall: wall(db) })
  const m = fired.ended === 'completed' ? read(fired.text) : null
  if (m === null) return told(db, found, now, 'needs_coo', `finding ${String(found.id)}: no outcome`)
  if (m.outcome === 'retire' && held === null) return told(db, found, now, 'needs_coo', `retire did not apply: no entry ${found.name}`)
  closeFinding(db, found.id, m.outcome, m.why, refOf(m, found, wire, held?.path), now)
  return told(db, found, now, 'pass', `${m.outcome}: ${m.why}`)
}

function read(text: string): Said | null {
  const fence = /^---\n([\s\S]*?)\n---$/m.exec(text)?.[1]
  if (fence === undefined || fence.match(/^outcome:/gm)?.length !== 1) return null
  const got = Said.safeParse(prose(fence, ['why', 'ref', 'title', 'files', 'ends']))
  return got.success ? got.data : null
}

function holder(root: string, name: string): { path: string; lines: string[]; at: Entry } | null {
  for (const path of registered(root)) {
    const lines = readFileSync(join(root, path), 'utf8').split('\n')
    const at = entryOf(lines, name)
    if (at !== null) return { path, lines, at }
  }
  return null
}

function entryOf(lines: string[], name: string): Entry | null {
  const from = lines.indexOf(`- name: ${name}`)
  if (from === -1) return null
  const to = lines.findIndex((l, i) => i > from && !l.startsWith(' '))
  return { from, to: to === -1 ? lines.length : to }
}

function line(found: Finding): string {
  return `finding ${String(found.id)}: ${found.name} is ${found.state}, ${found.detail}`
}

function refOf(m: Said, found: Finding, wire: Wire, path = ''): string | null {
  if (m.outcome === 'covered') return m.ref ?? null
  if (m.outcome === 'fixed') return null
  const [title, files, ends, priority] = m.outcome === 'retire'
    ? [`Retire registry entry ${found.name}`, path, `main no longer has the ${found.name} entry in ${path}`, 'P2']
    : [m.title ?? m.why, m.files ?? '', m.ends ?? '', 'P0']
  const body = `**What:** ${title}\n**Why:** ${m.why}\n**Files:** ${files}\n**When it ends:** ${ends}\n\nDrift ${line(found)}`
  return wire.file(SELF, title, body, ['lane:machine', priority, 'fix'])
}

function told(db: Db, found: Finding, now: Date, outcome: 'pass' | 'needs_coo', message: string): string {
  logged(db, { plan: null, kind: 'director', actor: 'director', outcome, message, pointer: `finding ${String(found.id)}`, run: null },
    now.toISOString())
  return message
}
