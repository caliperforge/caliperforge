import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { cost, opened, spawned } from '../store/transcript.ts'

const Line = z.object({
  type: z.enum(['assistant', 'user']),
  parent_tool_use_id: z.string().nullable(),
  message: z.object({
    id: z.string().optional(),
    content: z.array(z.looseObject({ type: z.string() })),
    usage: z.object({ input_tokens: z.number(), cache_creation_input_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), output_tokens: z.number() }).optional(),
  }),
})

type Line = z.infer<typeof Line>

const Call = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() })

const Answer = z.object({ type: z.literal('tool_result'), tool_use_id: z.string() })

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
}

function lines(path: string): Line[] {
  return readFileSync(path, 'utf8').split('\n').flatMap((text) => Line.safeParse(json(text)).data ?? [])
}

function ranked(tally: Map<string, number>): [string, number][] {
  return [...tally].sort((a, b) => b[1] - a[1])
}

function add(tally: Map<string, number>, key: string, n = 1): void {
  tally.set(key, (tally.get(key) ?? 0) + n)
}

function percent(part: number, whole: number): string {
  return `${String(whole === 0 ? 0 : Math.round((100 * part) / whole))}%`
}

/** Each turn is one message id, counted once, at its largest usage: the SDK repeats the turn's usage on every block's line. */
function turns(all: Line[]): { tokens: number; context: number; main: boolean }[] {
  const byId = new Map<string, { tokens: number; context: number; main: boolean }>()
  for (const { type, parent_tool_use_id, message: { id, usage } } of all) {
    if (type !== 'assistant' || id === undefined || usage === undefined) continue
    const context = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    const tokens = context + usage.output_tokens
    if (tokens >= (byId.get(id)?.tokens ?? -1)) byId.set(id, { tokens, context, main: parent_tool_use_id === null })
  }
  return [...byId.values()]
}

/** The cost profile of a transcript, one item per line. */
export function profiled(path: string): string {
  const all = lines(path)
  const names = new Map<string, string>()
  const calls = new Map<string, number>()
  for (const block of all.flatMap((line) => line.type === 'assistant' ? line.message.content : [])) {
    const call = Call.safeParse(block).data
    if (call === undefined) continue
    names.set(call.id, call.name)
    add(calls, call.name)
  }
  const filled = new Map<string, number>()
  for (const block of all.flatMap((line) => line.parent_tool_use_id === null ? line.message.content : [])) {
    const answer = Answer.safeParse(block).data
    add(filled, (answer === undefined ? undefined : names.get(answer.tool_use_id)) ?? block.type, JSON.stringify(block).length)
  }
  const reads = new Map<string, number>()
  for (const file of opened(path)) add(reads, file)
  const counted = turns(all)
  const main = counted.filter((turn) => turn.main)
  const tokens = counted.reduce((sum, turn) => sum + turn.tokens, 0)
  const chars = [...filled.values()].reduce((sum, n) => sum + n, 0)
  const cash = cost(path)
  return [
    `tokens ${String(tokens)}  cash ${cash === null ? 'none' : `$${cash.toFixed(2)}`}  main ${percent(main.reduce((sum, turn) => sum + turn.tokens, 0), tokens)}`,
    `context ${String(main.at(0)?.context ?? 'none')} -> ${String(main.at(-1)?.context ?? 'none')}`,
    ...ranked(filled).map(([category, n]) => `filled ${category} ${String(n)} ${percent(n, chars)}`),
    ...ranked(calls).map(([name, n]) => `calls ${name} ${String(n)}`),
    `agents ${String(spawned(path))}`,
    ...ranked(reads).slice(0, 10).map(([file, n]) => `read ${String(n)} ${file}`),
  ].map((line) => `${line}\n`).join('')
}
