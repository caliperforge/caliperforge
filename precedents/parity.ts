import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { gh, type Read } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { CAP } from '../sequencer/upstream.ts'
import { logged, pointers } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { wall, zone } from '../store/lanes.ts'
import { drifted, hashes } from '../store/parity.ts'
import { pending } from '../store/transcript.ts'
import { driftOf, type Opening } from './openings.ts'

const Entries = z.record(z.string(), z.object({ contract: z.string(), files: z.record(z.string(), z.string()) }))

const File = z.object({ size: z.number().max(CAP), content: z.string() })

const entries = (root: string) => Entries.parse(parse(readFileSync(join(root, 'precedents/parity.yaml'), 'utf8')))

export async function parities(db: Db, root: string, provider: Provider, now: Date, read: Read): Promise<void> {
  const local = new Date(now.getTime() + zone(db) * 60000)
  const monday = new Date(local.getTime() - ((local.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)
  if (pointers(db, 'parity_week').includes(monday)) return
  const event = { plan: null, kind: 'parity_week', actor: 'cf', pointer: monday, run: null }
  try {
    const ran: string[] = []
    for (const repo of Object.keys(entries(root))) {
      ran.push(`${repo} ${String(await parity(db, root, repo, provider, read, now.toISOString()) ?? 'unchanged')}`)
    }
    logged(db, { ...event, outcome: 'pass', message: ran.join(', ') })
  } catch (error) {
    logged(db, { ...event, outcome: 'refuse', message: error instanceof Error ? error.message : String(error) })
  }
}

export async function parity(db: Db, root: string, repo: string, provider: Provider, read: Read = gh,
  at = new Date().toISOString()): Promise<number | null> {
  const entry = entries(root)[repo]
  if (entry === undefined) throw new Error(`${repo} has no entry in precedents/parity.yaml`)
  const files = Object.entries(entry.files).map(([lang, path]) => {
    const got = Buffer.from(File.parse(read(['api', `repos/${repo}/contents/${path}`])).content.replace(/\n/g, ''), 'base64')
    const lines = got.toString('utf8').replace(/\n$/, '').split('\n')
    return { lang, path, lines, sha256: createHash('sha256').update(got).digest('hex') }
  })
  const had = hashes(db, repo)
  if (files.every((f) => had[f.path] === f.sha256)) return null
  load(db, root)
  const { manifest, prompt } = seat(root, 'shape_compare')
  const dir = join(root, '.cf/precedents')
  mkdirSync(dir, { recursive: true })
  const issue = [`# ${entry.contract}`, ...files.map((f) =>
    `## ${f.lang}: ${f.path}\n\n\`\`\`\n${f.lines.map((l, i) => `${String(i + 1)} ${l}`).join('\n')}\n\`\`\``)].join('\n\n')
  const built = packet(manifest, prompt, tight(root), issue, dir, pending(dir, `parity-${repo.replace('/', '-')}`))
  const fired = await provider.fire({ ...built, wall: wall(db) })
  if (fired.ended !== 'completed') {
    refused(db, repo, 'stopped')
    return 0
  }
  const cited = files.map((f) => ({ lang: f.lang, path: f.path, lines: f.lines.length }))
  const rows: Opening[] = []
  for (const line of fired.text.trim() === 'none' ? [] : fired.text.split('\n').map((l) => l.trim()).filter((l) => l !== '')) {
    const got = driftOf(line, cited)
    if (got === null) refused(db, repo, line)
    else rows.push(got)
  }
  drifted(db, repo, at, rows, Object.fromEntries(files.map((f) => [f.path, f.sha256])))
  return rows.length
}

function refused(db: Db, repo: string, message: string): void {
  logged(db, { plan: null, kind: 'parity_refused', actor: 'cf', outcome: 'refuse', message, pointer: repo, run: null })
}
