import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Db } from './index.ts'

const Turn = z.object({ type: z.literal('assistant'), message: z.object({ content: z.array(z.unknown()) }) })

const Read = z.object({ type: z.literal('tool_use'), name: z.literal('Read'), input: z.object({ file_path: z.string() }) })

const Spawn = z.object({ type: z.literal('tool_use'), name: z.literal('Agent') })

/** The content blocks of each assistant turn, in order; none when the transcript is missing or a line is not JSON. */
function blocks(path: string): unknown[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').flatMap((line) => Turn.safeParse(JSON.parse(line)).data?.message.content ?? [])
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return []
  }
}

/** The `file_path` of each Read call in a transcript, in order. */
export function opened(path: string): string[] {
  return blocks(path).flatMap((block) => Read.safeParse(block).data?.input.file_path ?? [])
}

/** How many sub-agents a transcript's turns spawned. */
export function spawned(path: string): number {
  return blocks(path).filter((block) => Spawn.safeParse(block).success).length
}

const Message = z.object({ type: z.enum(['assistant', 'user']), message: z.object({ content: z.array(z.unknown()) }), tool_use_result: z.unknown().optional() })

const Saved = z.object({ stdout: z.string().optional(), persistedOutputPath: z.string().optional() })

const Bash = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.literal('Bash'), input: z.object({ command: z.string() }) })

const Result = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }))]),
})

const MOVED = /did not complete within its .* timeout and was moved to the background/

const SAVED = /^Output too large .*Full output saved to: (.+)$/m

function full(text: string, saved: z.infer<typeof Saved> | undefined): string {
  if (!text.startsWith('<persisted-output>')) return text
  const file = saved?.persistedOutputPath ?? SAVED.exec(text)?.[1]?.trim()
  if (file !== undefined && existsSync(file)) return readFileSync(file, 'utf8')
  return saved?.stdout ?? text
}

/** Each Bash call's command and the text its result holds, in order; none when it is missing or a line is not JSON. */
export function outputs(path: string): { command: string; output: string }[] {
  if (!existsSync(path)) return []
  try {
    const blocks = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').flatMap((line) => {
      const message = Message.safeParse(JSON.parse(line)).data
      const saved = Saved.safeParse(message?.tool_use_result).data
      return (message?.message.content ?? []).map((block) => ({ block, saved }))
    })
    const commands = new Map(blocks.flatMap(({ block }) => {
      const call = Bash.safeParse(block).data
      return call === undefined ? [] : [[call.id, call.input.command] as const]
    }))
    return blocks.flatMap(({ block, saved }) => {
      const result = Result.safeParse(block).data
      const command = result === undefined ? undefined : commands.get(result.tool_use_id)
      if (result === undefined || command === undefined) return []
      return [{ command, output: full(typeof result.content === 'string' ? result.content : result.content.map((part) => part.text ?? '').join('\n'), saved) }]
    })
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return []
  }
}

/** The command of the last Bash call whose result says it was moved to the background; none when it is missing or a line is not JSON. */
export function unfinished(path: string): string | null {
  return outputs(path).filter((run) => MOVED.test(run.output)).at(-1)?.command ?? null
}

/** The name a provider writes under before the run it belongs to has an id. */
export function pending(dir: string, tag: string): string {
  return join(dir, `${tag}.pending.transcript.jsonl`)
}

/**
 * A transcript is named for its run. A retry repeats the step, so a name built
 * from the step overwrites the file an earlier `runs` row still points at; the
 * id is unique, and it exists only once the row is inserted.
 */
export function byRun(db: Db, run: number, written: string): string {
  const named = join(dirname(written), `run-${String(run)}.transcript.jsonl`)
  if (existsSync(written)) renameSync(written, named)
  db.prepare('UPDATE runs SET transcript_path = ? WHERE id = ?').run(named, run)
  return named
}

const FIGURE = /"total_cost_usd":(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/

/** A message and its newline are appended in one write, so only the text after the last newline can be cut short. */
export function cost(path: string): number | null {
  if (!existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n').slice(0, -1).reverse()) {
    const figure = FIGURE.exec(line)?.[1]
    if (figure !== undefined) return Number(figure)
  }
  return null
}

const Usage = z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadInputTokens: z.number(), cacheCreationInputTokens: z.number() })

const Ended = z.object({ type: z.literal('result'), modelUsage: z.record(z.string(), Usage) })

export type Models = Record<string, z.infer<typeof Usage>>

/** The `modelUsage` of a transcript's last result line; none when it is missing, `{}`, or a line is not JSON. */
export function models(path: string): Models | null {
  if (!existsSync(path)) return null
  try {
    const usage = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => Ended.safeParse(JSON.parse(line)).data?.modelUsage).findLast((u) => u !== undefined)
    return usage === undefined || Object.keys(usage).length === 0 ? null : usage
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
}

export function backfill(db: Db): number {
  const rows = db.prepare('SELECT id, transcript_path FROM runs WHERE cost_usd IS NULL').all() as { id: number; transcript_path: string }[]
  const write = db.prepare('UPDATE runs SET cost_usd = ? WHERE id = ? AND cost_usd IS NULL')
  let written = 0
  for (const row of rows) {
    const figure = cost(row.transcript_path)
    if (figure !== null) written += write.run(figure, row.id).changes
  }
  return written
}
