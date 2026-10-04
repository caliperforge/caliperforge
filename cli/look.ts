import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { planDir } from '../sequencer/workspace.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { select } from '../store/look.ts'
import type { Cli } from './cf-lanes.ts'
import { gh, inline, said, type Read } from './gh.ts'

const Said = z.array(z.object({ author: z.object({ login: z.string() }), body: z.string() }))

const Thread = z.object({ title: z.string(), body: z.string(), comments: Said, reviews: Said.default([]) })

export function planFile(root: string, id: number, file: string): string {
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('cf look plan reads only inside .cf/work/<id>')
  return readFileSync(join(planDir(root, id), file), 'utf8')
}

export function thread(repo: string, kind: string, no: number, read: Read = gh): string {
  if (kind !== 'issue' && kind !== 'pr') throw new Error('cf look gh takes issue or pr')
  const t = Thread.parse(read([kind, 'view', String(no), '--repo', repo, '--json',
    kind === 'pr' ? 'title,body,comments,reviews' : 'title,body,comments']))
  const lines = kind === 'pr' ? inline(repo, no, read).map(said) : []
  return [t.title, t.body, ...[...t.comments, ...t.reviews].map((c) => `## ${c.author.login}\n${c.body}`), ...lines].join('\n\n')
}

export function looked(db: Db, root: string, cwd: string, target: string): void {
  const first = relative(join(root, '.cf/work'), cwd).split(sep)[0] ?? ''
  logged(db, { plan: /^\d+$/.test(first) ? Number(first) : null, kind: 'look', actor: 'coo_lite', outcome: 'pass',
    message: target, pointer: null, run: null })
}

export function registerLook(cf: Command, { root, db, out }: Cli): void {
  const look = cf.command('look')

  look.command('store').argument('<sql>').action((sql: string) => {
    // A read-only handle on a WAL file opens only while a writer keeps its -wal and -shm files.
    const handle = db()
    for (const row of select(join(root, 'cf.db'), sql)) out(`${JSON.stringify(row)}\n`)
    looked(handle, root, process.cwd(), `store ${sql}`)
  })

  look.command('plan').argument('<id>').argument('<file>').action((id: string, file: string) => {
    out(planFile(root, Number(id), file))
    looked(db(), root, process.cwd(), `plan ${id} ${file}`)
  })

  look.command('gh').argument('<repo>').argument('<kind>').argument('<n>').action((repo: string, kind: string, n: string) => {
    out(`${thread(repo, kind, Number(n))}\n`)
    looked(db(), root, process.cwd(), `gh ${repo} ${kind} ${n}`)
  })
}
