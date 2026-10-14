import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { homeOf } from '../../sequencer/home.ts'
import { dial, lanes } from '../../store/lanes.ts'
import { openPipes, pipeNamed, planById } from '../../store/plans.ts'
import { laneLine } from '../brief.ts'
import type { Read } from '../gh.ts'
import { add } from '../plan.ts'

const schema = join(import.meta.dirname, '../../schema')
const SITE = 'https://github.com/caliperforge/site/issues/1'
const OURS = 'https://github.com/caliperforge/caliperforge/issues/25'

const canned = (url: string): Read => () =>
  ({ number: Number(url.split('/').at(-1)), title: 'Rebuild the site', body: 'the ask', url, labels: [{ name: 'lane:site' }] })

const root = (): string => mkdtempSync(join(tmpdir(), 'cf-site-'))

const row = (lane: string): string => `INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
  VALUES ((SELECT id FROM pipes WHERE name = 'site'), 'pr_path', 'queued', '2026-10-14', '${lane}', 'web_specialist', '${SITE}')`

test('D2 plans table takes the site lane and no unlisted lane', () => {
  expect(rejects(fresh(schema), row('site'))).toBe(false)
  expect(rejects(fresh(schema), row('solana'))).toBe(true)
})

test('D3 the site pipe ships on, all day, one wide', () => {
  const d = fresh(schema)
  expect(pipeNamed(d, 'site')).toMatchObject({ enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  expect(openPipes(d, '03:00').map((p) => p.name)).toContain('site')
})

test('D4 site: site lane, pipe, web seat, home', () => {
  const d = fresh(schema)
  const filed = add(d, root(), 'caliperforge/site#1', 'ceo', undefined, canned(SITE))
  expect(filed).toMatchObject({ state: 'queued', lane: 'site', seat: 'web_specialist' })
  const plan = planById(d, Number(filed.plan))
  expect(plan.pipe_id).toBe(pipeNamed(d, 'site')?.id)
  expect(homeOf(plan)).toBe('caliperforge/site')
})

test('D5 a site issue off caliperforge/site is refused', () => {
  const filed = add(fresh(schema), root(), 'caliperforge/caliperforge#25', 'ceo', undefined, canned(OURS))
  expect(filed.state).toBe('refused')
  expect(filed.why).toContain('the site lane builds in caliperforge/site')
})

test('D6 brief counts the bench and site pipes at 03:00', () => {
  const d = fresh(schema)
  dial(d, 2, '2026-10-14')
  expect(laneLine(lanes(d, '03:00'))).toMatch(/^lanes 0\/3 live\/open/)
})
