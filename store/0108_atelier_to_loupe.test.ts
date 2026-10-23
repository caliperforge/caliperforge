import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open, type Db } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Pipe { id: number; name: string }

function at0107(names: string[]): Db {
  const old = mkdtempSync(join(tmpdir(), 'cf-0107-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0108')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  for (const name of names) {
    db.prepare("INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES (?, 1, '00:00', '23:59', 1)").run(name)
  }
  return db
}

const pipes = (db: Db): Pipe[] => db.prepare('SELECT id, name FROM pipes ORDER BY id').all() as Pipe[]
const id = (db: Db, name: string): number | undefined => pipes(db).find((p) => p.name === name)?.id
const plans = (db: Db): unknown[] => db.prepare('SELECT pipe_id, lane FROM plans ORDER BY id').all()
const science = (before: Pipe[]): Pipe[] => ['rubin', 'bio'].map((name, i) => ({ id: before.length + i + 1, name }))

const plan = (db: Db, pipe: string, lane: string, origin: string): void => {
  db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, priority, lane, seat, origin, title)
    VALUES (?, 'pr_path', 'queued', '2026-10-16', 1, ?, 'web_specialist', ?, 't')`).run(id(db, pipe), lane, origin)
}

const web = (n: number): string => `https://github.com/caliperforge/atelier-web/issues/${String(n)}`

it('D1 the atelier pipe is renamed loupe and keeps its id', () => {
  const db = at0107(['atelier'])
  plan(db, 'atelier', 'atelier', web(1))
  const before = pipes(db)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0108_atelier_to_loupe.sql', '0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql'])
  expect(pipes(db)).toEqual([...before.map((p) => (p.name === 'atelier' ? { ...p, name: 'loupe' } : p)), ...science(before)])
  expect(plans(db)).toEqual([{ pipe_id: id(db, 'loupe'), lane: 'loupe' }])
})

it('D2 atelier plans move onto the existing loupe pipe', () => {
  const db = at0107(['atelier', 'loupe'])
  plan(db, 'atelier', 'atelier', web(1))
  plan(db, 'loupe', 'loupe', web(2))
  const before = pipes(db)
  migrate(db, join(root, 'schema'))
  expect(pipes(db)).toEqual([...before, ...science(before)])
  expect(plans(db)).toEqual([{ pipe_id: id(db, 'loupe'), lane: 'loupe' }, { pipe_id: id(db, 'loupe'), lane: 'loupe' }])
})

it('D3 with neither pipe a machine plan is untouched', () => {
  const db = at0107([])
  plan(db, 'pr-path', 'machine', 'https://github.com/caliperforge/caliperforge/issues/1')
  const before = { pipes: pipes(db), plans: plans(db) }
  migrate(db, join(root, 'schema'))
  expect({ pipes: pipes(db), plans: plans(db) }).toEqual({ ...before, pipes: [...before.pipes, ...science(before.pipes)] })
  expect(before.plans).toEqual([{ pipe_id: id(db, 'pr-path'), lane: 'machine' }])
})
