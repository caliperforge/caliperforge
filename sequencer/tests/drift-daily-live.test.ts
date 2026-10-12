import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('daily_live: stale 30h after the newest daily went live', () => {
  const live = REGISTRY.filter((e) => e.name === 'daily_live')
  const post = (d: Db, kind: string, at: string): Db => {
    d.exec(`INSERT INTO desk_posts (kind, dest, status, title, dek, body, sources, checks, work_date, written_date, published_at)
      VALUES ('${kind}', 'site', 'published', 't', 'd', 'b', '[]', '[]', '2026-10-01', '2026-10-01', ${at})`)
    return d
  }
  const d = post(db(), 'daily', 'NULL')
  expect(drift(d, live, NOW)).toEqual([{ name: 'daily_live', state: 'silent',
    detail: "no row in desk_posts WHERE kind = 'daily' AND published_at IS NOT NULL" }])
  const stale = [{ name: 'daily_live', state: 'stale',
    detail: 'newest desk_posts.published_at is 2026-10-02T03:00:00.000Z, older than 30h', newest: '2026-10-02T03:00:00.000Z' }]
  post(d, 'daily', "'2026-10-02T03:00:00.000Z'")
  expect(drift(post(d, 'weekly', "'2026-10-02T09:00:00.000Z'"), live, NOW)).toEqual(stale)
  expect(drift(post(db(), 'daily', "'2026-10-02T05:00:00.000Z'"), live, NOW)).toEqual([])
  expect(drift(post(db(0), 'daily', "'2026-10-02T03:00:00.000Z'"), live, NOW)).toEqual([])
})
