import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { fresh } from '../../checks/sqlite.ts'
import type { Pr } from '../../cli/gh.ts'
import { listed } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
import { Entry } from '../drift.ts'

const schema = join(import.meta.dirname, '../../schema')
export const NOW = new Date('2026-10-03T10:00:00Z')
export const COO = { name: 'director', switch: { key: 'director.apply', value: '1' }, table: 'events', column: 'at', where: "kind = 'director'", gap: '2d' }
export const REGISTRY = z.array(Entry).parse(parse(readFileSync(join(import.meta.dirname, '../../rules/registry.yaml'), 'utf8')))

export function db(enabled = 1): Db {
  const d = fresh(schema)
  d.exec(`UPDATE pipes SET enabled = ${String(enabled)};
    INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT min(id) FROM pipes), 'pr_path', 'queued', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/1', 0, 3);
    INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES ('director.apply', '1', 'ceo', 'ruling', 'r', '2026-10-01')`)
  return d
}

export function work(d: Db, step: number, path: string): void {
  d.exec(`UPDATE plans SET step = ${String(step)} WHERE id = 1`)
  listed(d, 1, path)
}

export function event(d: Db, at: string, kind = 'director'): void {
  d.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, ?, ?, ?, 'pass', 'm')").run(at, kind, kind)
}

export function internal(enabled = 1, max = 2): Db {
  const d = fresh(schema)
  d.exec(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('internal', ${String(enabled)}, '00:00', '23:59', ${String(max)});
    INSERT INTO gardens (day, metric, url) VALUES ('2026-09-28', 'prepare', 'https://github.com/a/b/issues/9')`)
  return d
}

export function queue(d: Db, priority: number): void {
  d.exec(`INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT id FROM pipes WHERE name = 'internal'), 'pr_path', 'queued', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/1', 0, ${String(priority)})`)
}

export const unread = (): Pr => { throw new Error('read') }
