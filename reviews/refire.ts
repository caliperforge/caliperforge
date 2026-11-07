import type { Packet } from '../providers/kind.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { broken } from './verdict.ts'

const RESTATE = 'Restate the verdict above in the fence your instructions give, and nothing else.'
const QUOTE = 'Write a value that carries code as one JSON string on its line.'

export function again(db: Db, plan: number, name: string, packet: Packet, first: { run: number; text: string; capped: boolean }): Packet {
  if (first.capped) return { ...packet, tools: [] }
  logged(db, { plan, kind: 'review', actor: name, outcome: 'pass', message: `${name} refired for the verdict fence`, pointer: null, run: first.run })
  const error = broken(first.text)
  const fix = error === null ? '' : `Your fence does not parse: ${error}\n${QUOTE}\n\n`
  return { ...packet, tools: [], prompt: `${packet.prompt}\n\n# Your answer\n\n${first.text}\n\n${fix}${RESTATE}` }
}
