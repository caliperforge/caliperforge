import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { Generated } from '../store/runs.ts'

const Usage = z.object({ input_tokens: z.number(), cache_creation_input_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), output_tokens: z.number() })

type Usage = z.infer<typeof Usage>

const Line = z.object({ type: z.literal('assistant'), parent_tool_use_id: z.string().nullish(), message: z.object({ id: z.string(), usage: Usage }) })

const Meta = z.object({ description: z.string() })

interface Row { file: string; description: string; input: number; write: number; read: number; output: number; turns: number }

const KEYS = ['input', 'write', 'read', 'output'] as const

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
}

function tokens(usage: Usage): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens
}

/** One turn per message id, at its largest usage; on `main`, only the turns the SDK stream did not relay from a sub-agent. */
function counted(path: string, main: boolean): Omit<Row, 'file' | 'description'> {
  const byId = new Map<string, Usage>()
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    const line = Line.safeParse(json(text)).data
    if (line === undefined || (main && typeof line.parent_tool_use_id === 'string')) continue
    const { id, usage } = line.message
    const was = byId.get(id)
    if (was === undefined || tokens(usage) >= tokens(was)) byId.set(id, usage)
  }
  const turns = [...byId.values()]
  const sum = (of: (usage: Usage) => number): number => turns.reduce((n, usage) => n + of(usage), 0)
  return {
    input: sum((u) => u.input_tokens), write: sum((u) => u.cache_creation_input_tokens ?? 0),
    read: sum((u) => u.cache_read_input_tokens ?? 0), output: sum((u) => u.output_tokens), turns: turns.length,
  }
}

function agents(session: string | null): Row[] {
  if (session === null) return []
  const dir = join(session, 'subagents')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((file) => /^agent-.*\.jsonl$/.test(file)).sort().map((file) => ({
    file,
    description: Meta.parse(JSON.parse(readFileSync(join(dir, file.replace(/\.jsonl$/, '.meta.json')), 'utf8'))).description,
    ...counted(join(dir, file), false),
  }))
}

export function split(main: string, session: string | null): Row[] {
  return [{ file: basename(main), description: 'main', ...counted(main, true) }, ...agents(session)]
}

export function sessionDir(projects: string, session: string | null): string | null {
  if (session === null) return null
  return readdirSync(projects).map((slug) => join(projects, slug, session)).find((dir) => existsSync(dir)) ?? null
}

export function render(run: Generated, rows: Row[]): string {
  const id = `run ${String(run.id)}${run.phase === null ? '' : ` ${run.phase}`}`
  const total = (key: typeof KEYS[number]): number => rows.reduce((n, row) => n + row[key], 0)
  const logged = { input: run.input_tokens - run.cache_write_tokens, write: run.cache_write_tokens, read: run.cache_read_tokens, output: run.output_tokens }
  const gap = KEYS.reduce((n, key) => n + logged[key] - total(key), 0)
  return [
    ...rows.map((row) => [id, row.file, ...KEYS.map((key) => `${key} ${String(row[key])}`), `turns ${String(row.turns)}`, row.description]),
    [id, 'sum', ...KEYS.map((key) => `${key} ${String(total(key))}/${String(logged[key])}`), `gap ${String(gap)}`],
  ].map((cells) => `${cells.join('\t')}\n`).join('')
}
