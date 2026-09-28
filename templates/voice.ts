import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import { edited } from '../store/desk.ts'
import type { Db } from '../store/index.ts'

const FIELDS = ['title', 'dek', 'body'] as const

function pattern(draft: number, edit: number): string {
  if (edit === 0) return 'cut'
  if (edit * 10 < draft * 9) return 'shortened'
  if (edit * 10 > draft * 11) return 'lengthened'
  return 'reworded'
}

export function capture(db: Db, root: string): Outcome {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(root, 'comms/voice-notes.md')
  const had = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : null
  const lines = edited(db).flatMap((row) => FIELDS.flatMap((field) => {
    const edit = row[`edited_${field}`]
    if (edit === null) return []
    const note = row.note === null ? '' : ` — note: ${row.note}`
    return [`- ${today} ${String(row.id)} ${field}: ${pattern(row[field].length, edit.length)} (${String(row[field].length)} → ${String(edit.length)} chars)${note}`]
  })).filter((line) => had?.includes(line) !== true)
  if (lines.length > 0) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${had === null ? '# Voice notes\n\n' : ''}${lines.join('\n')}\n`)
  }
  return { outcome: 'pass', spans: [], note: `${String(lines.length)} voice note(s) added` }
}
