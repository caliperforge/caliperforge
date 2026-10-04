import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { pointers } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { record } from '../../store/signals.ts'
import { learned } from '../learn.ts'
import { put } from '../workspace.ts'

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const B = 'b'.repeat(40)
const LINK = 'https://github.com/caliperforge/pay-kit/pull/15#discussion_r11'

function setup(findings: string): { db: Db; root: string; swift: string } {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  db.pragma('foreign_keys = OFF')
  const root = mkdtempSync(join(tmpdir(), 'cf-learn-'))
  record(db, { repo: 'caliperforge/pay-kit', pr: 15, kind: 'bot_review', author: 'greptile-apps[bot]', at: '2026-10-03',
    external_id: 'r1', score: 3, plan: 1, head: A })
  put(root, 1, `findings-${A}.md`, findings)
  return { db, root, swift: join(root, '.cf/examples/swift.md') }
}

test('a fixed finding becomes one Swift example line', () => {
  const { db, root, swift } = setup('- G11 Sources/Pay.swift:7 drops description\nand more\n')
  learned(db, root, 1, B)
  expect(readFileSync(swift, 'utf8')).toBe('## Found by Greptile and fixed\n\n'
    + `- pay-kit#15 \`caliperforge/pay-kit@a1b2c3d:Sources/Pay.swift:7\`: drops description (${LINK}).\n`)
  expect(pointers(db, 'examples.learned')).toEqual([LINK])
})

test('a finding rulings.md accepts is not learned', () => {
  const { db, root, swift } = setup('- G11 Sources/Pay.swift:7 drops description\n')
  put(root, 1, 'rulings.md', `accepted:\n  head: ${A.slice(0, 7)}\n  ids: G11\n  reason: upstream shape\n`)
  learned(db, root, 1, B)
  expect(existsSync(swift)).toBe(false)
  expect(pointers(db, 'examples.learned')).toEqual([])
})

test('a second run appends nothing', () => {
  const { db, root, swift } = setup('- G11 Sources/Pay.swift:7 drops description\n')
  learned(db, root, 1, B)
  const once = readFileSync(swift, 'utf8')
  learned(db, root, 1, B)
  expect(readFileSync(swift, 'utf8')).toBe(once)
  expect(pointers(db, 'examples.learned')).toHaveLength(1)
})

test('a kept finding or an unclaimed path is skipped', () => {
  const { db, root, swift } = setup('- G11 Sources/Pay.swift:7 drops description\n- G12 README.md:3 typo\n')
  put(root, 1, `findings-${B}.md`, '- G11 Sources/Pay.swift:7 drops description\n')
  learned(db, root, 1, B)
  expect(existsSync(swift)).toBe(false)
  expect(existsSync(join(root, '.cf/examples'))).toBe(false)
  expect(pointers(db, 'examples.learned')).toEqual([])
})
