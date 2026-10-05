import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('holds a comms title to one plan and ignores untitled ones', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const comms = (title: string | null): unknown => db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, title)
    VALUES ((SELECT id FROM pipes WHERE name = 'comms'), 'comms', 'queued', '2026-09-27T00:00:00.000Z', 0, 0, ?)`).run(title)
  comms('daily 2026-09-27')
  comms(null)
  comms(null)
  expect(() => comms('daily 2026-09-27')).toThrow(/UNIQUE/)
})
