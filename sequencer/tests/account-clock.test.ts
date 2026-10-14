import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { addSetting } from '../../store/drift.ts'
import { kindsOf } from '../../store/events.ts'
import { set, width } from '../../store/lanes.ts'
import { allPlans, dropPlan, titles } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { accounts } from '../accounts.ts'
import { maybe } from '../workspace.ts'
import { stub, world, type World } from './world.ts'

const MONDAY = new Date('2026-10-19T12:30:00Z')

const ASKS = ['evm-security', 'solana-foundation'].map((slug) => `# account ${slug} 2026-10-19\n\n**Account:** ${slug}\n`)

/** `copy = false` leaves no `accounts/`, so a call that read it would throw. */
function clocked(on?: string, copy = true): World {
  const w = world()
  dropPlan(w.db, 1)
  set(w.db, 'tick.zone_offset_minutes', '-360', 'ceo', '2026-10-01')
  if (on !== undefined) addSetting(w.db, { key: 'accounts.weekly', value: on, who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-10-13' })
  if (copy) cpSync(join(import.meta.dirname, '../../accounts'), join(w.root, 'accounts'), { recursive: true })
  return w
}

const asks = (w: World): (string | null)[] => allPlans(w.db).map((p) => maybe(w.root, p.id, 'ask.md')).sort()

test('D1 Monday 06:30 files one account plan per account', () => {
  const w = clocked('1')
  accounts(w.db, w.root, MONDAY)
  expect(titles(w.db, 'account').sort()).toEqual(['account evm-security 2026-10-19', 'account solana-foundation 2026-10-19'])
  expect(asks(w)).toEqual(ASKS)
})

test('D2 a tick files the plans and steps each read', async () => {
  const w = clocked('1')
  width(w.db, 1, 2)
  await tick(w.db, w.root, stub(''), MONDAY)
  expect(asks(w)).toEqual(ASKS)
  for (const { id } of allPlans(w.db)) {
    expect(kindsOf(w.db, id)).toEqual([{ kind: 'filed', outcome: 'pass' }, { kind: 'read', outcome: 'pass' }])
  }
})

test('D3 a second call the same local date files nothing', () => {
  const w = clocked('1')
  accounts(w.db, w.root, MONDAY)
  accounts(w.db, w.root, new Date('2026-10-19T20:00:00Z'))
  expect(allPlans(w.db)).toHaveLength(2)
})

test('D4 off, early or not Monday files and reads nothing', () => {
  const cases: [string | undefined, string][] = [[undefined, '2026-10-19T12:30:00Z'], ['0', '2026-10-19T12:30:00Z'],
    ['1', '2026-10-19T12:29:00Z'], ['1', '2026-10-20T12:30:00Z']]
  for (const [on, at] of cases) {
    const w = clocked(on, false)
    accounts(w.db, w.root, new Date(at))
    expect(allPlans(w.db)).toEqual([])
  }
})
