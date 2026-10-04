import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import { put } from '../sequencer/workspace.ts'
import { learningsIn } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { get } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'

export const shift = (day: string, days: number): string => new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10)

export function weekly(db: Db, root: string, plan: PlanRow, day: string): Outcome {
  const value = get(db, 'comms.story_dir')
  if (value === '') return { outcome: 'refuse', spans: ['comms.story_dir'], note: 'comms.story_dir is unset' }
  const dir = value.replace(/^~(?=\/|$)/, homedir())
  if (!existsSync(dir)) return { outcome: 'refuse', spans: [dir], note: `comms.story_dir ${dir} does not exist` }
  const story = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map(({ name }) => ({ name, text: readFileSync(join(dir, name), 'utf8') })).sort((a, b) => a.name.localeCompare(b.name))
  const learned = learningsIn(db, shift(day, -6), day)
  put(root, plan.id, 'packet.json', JSON.stringify({ learnings: learned, story }))
  return { outcome: 'pass', spans: [], note: `${String(learned.length)} learning day(s), ${String(story.length)} story file(s)` }
}
