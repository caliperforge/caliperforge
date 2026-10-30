import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Db } from './index.ts'

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

interface Rates { input: number; cache_write: number; cache_write_1h: number | null; cache_read: number; output: number }

const RATES = `SELECT input, cache_write, cache_write_1h, cache_read, output FROM prices
  WHERE provider = ? AND model = ? AND julianday(effective_from) <= julianday(?) ORDER BY julianday(effective_from) DESC LIMIT 1`

interface Seat { provider: string; model: string; at: string; cache_write_tokens: number | null; cache_write_1h_tokens: number | null }

/** Each model's tokens at its own rates in force at `runs.at`, or the seat model's; only the seat model's writes are 1-hour writes. */
export function byModel(db: Db, id: number, usage: Models): number | null {
  const run = db.prepare('SELECT provider, model, at, cache_write_tokens, cache_write_1h_tokens FROM runs WHERE id = ?').get(id) as Seat
  const rates = (model: string): Rates | undefined => db.prepare(RATES).get(run.provider, model, run.at) as Rates | undefined
  const seat = rates(run.model)
  const hours = run.cache_write_1h_tokens
  let cost: number | null = null
  if (seat !== undefined && run.cache_write_tokens !== null && hours !== null) {
    cost = Object.entries(usage).reduce<number | null>((sum, [model, u]) => {
      const p = rates(model) ?? seat
      const hour = model === run.model ? Math.min(hours, u.cacheCreationInputTokens) : 0
      return sum === null || p.cache_write_1h === null ? null : sum + (u.inputTokens * p.input + (u.cacheCreationInputTokens - hour) * p.cache_write
        + hour * p.cache_write_1h + u.cacheReadInputTokens * p.cache_read + u.outputTokens * p.output) / 1e6
    }, 0)
  }
  db.prepare('UPDATE runs SET cost_computed_usd = ? WHERE id = ?').run(cost, id)
  return cost
}
