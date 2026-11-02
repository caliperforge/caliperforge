import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { pending } from '../store/transcript.ts'
import { type Opening, opened, openingOf } from './openings.ts'
import { distilled, type Precedent, type Source, type Thread, threads, undistilled } from './store.ts'

const ROW = /^- area: (?<area>.+?) \| decision: (?<decision>.+?) \| why: (?<why>.+?) \| said_by: (?<said_by>\S+) \((?:maintainer|contributor)\) \| source: (?<source>\S+)$/

export async function distill(db: Db, root: string, repo: string, provider: Provider): Promise<number | null> {
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
  for (const line of lines) {
    const got = line.startsWith('- opening: ') ? openingOf(line, said) : rowOf(line, said)
    if (got === null) refused(db, pr, line)
    else if ('quote' in got) found.push(got)
    else rows.push(got)
  }
  opened(db, pr, found)
  distilled(db, pr, rows, fired.usage.input + fired.usage.cache + fired.usage.output)
  return rows.length
}

export async function drained(db: Db, root: string, repo: string, provider: Provider): Promise<{ prs: number; rows: number }> {
  let prs = 0
  let rows = 0
  for (let got = await distill(db, root, repo, provider); got !== null; got = await distill(db, root, repo, provider)) {
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

function refused(db: Db, pr: Source, message: string): void {
  logged(db, { plan: null, kind: 'precedent_refused', actor: 'cf', outcome: 'refuse', message, pointer: `${pr.repo}#${String(pr.number)}`, run: null })
}
