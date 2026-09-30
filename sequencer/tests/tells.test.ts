import { mkdirSync } from 'node:fs'
import { expect, test } from 'vitest'
import type { Row } from '../card.ts'
import { prosed } from '../tells.ts'
import { srcDir } from '../workspace.ts'
import { world } from './world.ts'

const TARGET = { repo: 'acme/widget', issue_no: 12, named_merger: 'maintainer' }

function checked(title: string, body: string): Row {
  const w = world()
  mkdirSync(srcDir(w.root, w.plan), { recursive: true })
  return prosed(title, body)(w.db, w.root, w.plan, TARGET)
}

test('D1 a tell on body line 5 flags with its line', () => {
  const row = checked('Fix the parser', 'Fixes #3.\n\nThe parser\nreads tabs.\nWe Delve into it.\n')
  expect(row).toMatchObject({ check: 'prose', ok: false })
  expect(row.says).toContain('body:5 tell:delve')
})

test('a preamble title and a hedged line flag with their kinds', () => {
  const row = checked('Here is the fix', 'Fixes #3.\n\nThis perhaps helps.\n')
  expect(row.ok).toBe(false)
  expect(row.says).toContain('title:1 tight.preamble')
  expect(row.says).toContain('body:3 tight.hedge')
})

test('D3 a clean title and body pass', () => {
  expect(checked('Fix the parser', 'Fixes #3.\n\nThe parser reads tabs.\n')).toEqual({ check: 'prose', ok: true, says: 'clean' })
})
