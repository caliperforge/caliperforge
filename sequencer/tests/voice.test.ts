import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { capture } from '../voice.ts'
import { world, type World } from './world.ts'

const today = new Date().toISOString().slice(0, 10)

const posted = (w: World, id: number, edits: { title?: string; dek?: string; body?: string; note?: string } = {},
  draft = { title: 'The day', dek: 'What moved', body: 'One job landed.' }): unknown =>
  w.db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note,
    sources, checks, work_date, written_date) VALUES (?, 'daily', 'site', 'proof', ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`)
    .run(id, draft.title, draft.dek, draft.body, edits.title ?? null, edits.dek ?? null, edits.body ?? null, edits.note ?? null, today, today)

const notes = (w: World): string => readFileSync(join(w.root, 'comms/voice-notes.md'), 'utf8')

test('D1: a row with only edited_title adds one line under a new header', () => {
  const w = world()
  posted(w, 1, { title: 'The whole day' })
  expect(capture(w.db, w.root)).toEqual({ outcome: 'pass', spans: [], note: '1 voice note(s) added' })
  expect(notes(w)).toBe(`# Voice notes\n\n- ${today} 1 title: lengthened (7 → 13 chars)\n`)
})

test('D2: a row with no edited field adds no line, and no file is made', () => {
  const w = world()
  posted(w, 1)
  expect(capture(w.db, w.root)).toMatchObject({ note: '0 voice note(s) added' })
  expect(existsSync(join(w.root, 'comms/voice-notes.md'))).toBe(false)
})

test('D3: a second capture adds nothing', () => {
  const w = world()
  posted(w, 1, { dek: 'What moved today', body: '' })
  capture(w.db, w.root)
  const first = notes(w)
  expect(capture(w.db, w.root)).toMatchObject({ note: '0 voice note(s) added' })
  expect(notes(w)).toBe(first)
})

test.each([['', 'cut'], ['a'.repeat(8), 'shortened'], ['a'.repeat(9), 'reworded'], ['a'.repeat(11), 'reworded'], ['a'.repeat(12), 'lengthened']])(
  'D4: a 10-char draft edited to %j is %s', (edit, pattern) => {
    const w = world()
    posted(w, 1, { body: edit }, { title: 'The day', dek: 'What moved', body: 'a'.repeat(10) })
    capture(w.db, w.root)
    expect(notes(w)).toContain(`- ${today} 1 body: ${pattern} (10 → ${String(edit.length)} chars)\n`)
  })

test('D5: a note ends each of its row\'s lines, and a null note adds nothing', () => {
  const w = world()
  posted(w, 1, { title: 'The day!', dek: 'What moved!', note: 'less flat' })
  posted(w, 2, { title: 'A day' })
  capture(w.db, w.root)
  expect(notes(w).split('\n').slice(2, -1)).toEqual([
    `- ${today} 1 title: lengthened (7 → 8 chars) — note: less flat`,
    `- ${today} 1 dek: reworded (10 → 11 chars) — note: less flat`,
    `- ${today} 2 title: shortened (7 → 5 chars)`,
  ])
})
