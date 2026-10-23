import { readFileSync } from 'node:fs'
import type { Db } from '../store/index.ts'
import { propose, type Item } from '../store/proposals.ts'
import { latest, rulingId } from '../store/rulings.ts'
import { searchIssue } from './gh.ts'

const ITEM = /^(RULING|WORK|ORDERING|WORLD|MEASUREMENT)\s+([a-z][a-z0-9_.]*)\s*=\s*(\S+)\s*$/

const CLASS_OF: Record<string, Item['class']> = {
  RULING: 'ruling', WORK: 'work', ORDERING: 'ordering', WORLD: 'world_fact', MEASUREMENT: 'measurement',
}

export interface Settled {
  class: Item['class']
  subject: string
  value: string
  line: number
}

type FindIssue = (subject: string) => number | null

export function settled(transcript: string): Settled[] {
  return transcript.split('\n').flatMap((text, index) => {
    const hit = ITEM.exec(text.trim())
    if (hit === null) return []
    const found = CLASS_OF[String(hit[1])]
    return found === undefined ? [] : [{ class: found, subject: String(hit[2]), value: String(hit[3]), line: index + 1 }]
  })
}

/**
 * The transcript's prose is read and dropped; only the typed line survives, and
 * only as `path:line`. Nothing this writes can be quoted back as a ruling.
 */
export function close(db: Db, path: string, find: FindIssue = search): number[] {
  return settled(readFileSync(path, 'utf8'))
    .filter((s) => latest(db, s.subject)?.value !== s.value)
    .flatMap((s) => propose(db, {
      class: s.class,
      subject: s.subject,
      value: s.value,
      match_ruling_id: rulingId(db, s.subject),
      match_issue_no: find(s.subject),
      evidence: `${path}:${String(s.line)}`,
    }) ?? [])
}

function search(subject: string): number | null {
  return searchIssue('caliperforge/caliperforge', subject)
}
