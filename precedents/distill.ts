import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { gh, inline, type Read } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { type Finding, flag } from '../store/precedent-findings.ts'
import { pending } from '../store/transcript.ts'
import { type Opening, opened, openingOf } from './openings.ts'
import { distilled, type Precedent, type Source, type Thread, threads, undistilled } from './store.ts'

const ROW = /^- area: (?<area>.+?) \| decision: (?<decision>.+?) \| why: (?<why>.+?) \| said_by: (?<said_by>\S+) \((?:maintainer|contributor)\) \| source: (?<source>\S+)$/

const BOT = /^- bot: (?<finding>.+?) \| area: (?<area>.+?) \| acted_on: (?<acted_on>fixed|agreed|ignored) \| source: (?<source>\S+)$/

const Commits = z.array(z.object({ sha: z.string() }))

const Commit = z.object({ files: z.array(z.object({ filename: z.string(), patch: z.string().optional() })) })

export async function distill(db: Db, root: string, repo: string, provider: Provider, read: Read = gh): Promise<number | null> {
  const pr = undistilled(db, repo)
  if (pr === undefined) return null
  load(db, root)
  const { manifest, prompt } = seat(root, 'precedent_writer')
  const dir = join(root, '.cf/precedents')
  mkdirSync(dir, { recursive: true })
  const said = threads(db, repo, pr.number)
  const issue = `# ${pr.title}\n\n## Paths\n\n${pr.files.join('\n')}\n\n## Threads\n\n${said.map((t) => JSON.stringify(t)).join('\n')}`
  const built = packet(manifest, prompt, tight(root), issue, dir, pending(dir, `${repo.replace('/', '-')}-${String(pr.number)}`))
  const fired = await provider.fire({ ...built, wall: wall(db) })
  if (fired.ended !== 'completed') refused(db, pr, 'stopped')
  const lines = fired.ended === 'completed' && fired.text.trim() !== 'none'
    ? fired.text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    : []
  const rows: Precedent[] = []
  const found: Opening[] = []
  const findings: Finding[] = []
  for (const line of lines) {
    const got = line.startsWith('- bot: ') ? findingOf(line, said, pr, read) : line.startsWith('- opening: ') ? openingOf(line, said) : rowOf(line, said)
    if (got === null) {
      refused(db, pr, line)
      continue
    }
    if ('acted_on' in got) findings.push(got)
    else if ('quote' in got) found.push(got)
    else rows.push(got)
  }
  opened(db, pr, found)
  flag(db, pr.repo, pr.number, findings)
  distilled(db, pr, rows, fired.usage.input + fired.usage.cache + fired.usage.output)
  return rows.length
}

export async function drained(db: Db, root: string, repo: string, provider: Provider, read: Read = gh): Promise<{ prs: number; rows: number }> {
  let prs = 0
  let rows = 0
  for (let got = await distill(db, root, repo, provider, read); got !== null; got = await distill(db, root, repo, provider, read)) {
    prs++
    rows += got
  }
  return { prs, rows }
}

function rowOf(line: string, said: Thread[]): Precedent | null {
  const got = ROW.exec(line)?.groups
  if (got === undefined || !said.some((t) => t.url === got.source)) return null
  const { area, decision, why, said_by, source } = got as Omit<Precedent, 'role'>
  const role = said.some((t) => t.author === said_by && t.role === 'maintainer') ? 'maintainer' : 'contributor'
  return { area, decision, why, said_by, role, source }
}

function findingOf(line: string, said: Thread[], pr: Source, read: Read): Finding | null {
  const got = BOT.exec(line)?.groups
  const b = said.find((t) => t.url === got?.source)
  if (got === undefined || b === undefined) return null
  const { finding, area, acted_on, source } = got as Record<keyof Finding, string>
  const row = { finding, area, acted_on: acted_on as Finding['acted_on'], source }
  if (acted_on === 'ignored') return row
  if (acted_on === 'agreed') return b.path !== null && said.some((t) => t.role === 'maintainer' && t.path === b.path && t.line === b.line) ? row : null
  const id = /#discussion_r(\d+)$/.exec(source)?.[1]
  return id !== undefined && changed(read, pr, Number(id)) ? row : null
}

function changed(read: Read, pr: Source, id: number): boolean {
  const c = inline(pr.repo, pr.number, read).find((l) => l.id === id && l.original_line !== null)
  if (c === undefined) return false
  const shas = Commits.parse(read(['api', `repos/${pr.repo}/pulls/${String(pr.number)}/commits?per_page=100`])).map((s) => s.sha)
  const at = shas.indexOf(c.original_commit_id)
  const next = at === -1 ? undefined : shas.at(at + 1)
  if (next === undefined) return false
  const patch = Commit.parse(read(['api', `repos/${pr.repo}/commits/${next}`])).files.find((f) => f.filename === c.path)?.patch
  let old = 0
  for (const l of patch?.split('\n') ?? []) {
    if (l.startsWith('-') && old === c.original_line) return true
    const hunk = /^@@ -(\d+)/.exec(l)
    old = hunk !== null ? Number(hunk[1]) : /^[- ]/.test(l) ? old + 1 : old
  }
  return false
}

function refused(db: Db, pr: Source, message: string): void {
  logged(db, { plan: null, kind: 'precedent_refused', actor: 'cf', outcome: 'refuse', message, pointer: `${pr.repo}#${String(pr.number)}`, run: null })
}
