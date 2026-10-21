import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { planDir, put } from '../sequencer/workspace.ts'
import type { Cli } from './cf-lanes.ts'

const AT = /^(.+):(\d+)$/
const NAMES = ['answer.md', 'sources.json']

const Turn = z.object({ type: z.literal('assistant'), message: z.object({ content: z.array(z.unknown()) }) })

const Write = z.object({ type: z.literal('tool_use'), name: z.literal('Write'), input: z.object({ file_path: z.string(), content: z.string() }) })

export function restore(root: string, plan: number, at: string): string[] {
  const hit = AT.exec(at)
  if (hit === null) throw new Error(`cf restore takes <plan> <transcript>:<line>, not ${at}`)
  const path = resolve(planDir(root, plan), String(hit[1]))
  const n = Number(hit[2])
  const line = readFileSync(path, 'utf8').split('\n')[n - 1]
  if (line === undefined) throw new Error(`${path} has no line ${String(n)}`)
  const turn = Turn.safeParse(JSON.parse(line))
  if (!turn.success) throw new Error(`${path}:${String(n)} is not an assistant turn`)
  const last = new Map(turn.data.message.content.flatMap((block) => {
    const write = Write.safeParse(block).data?.input
    return write === undefined ? [] : [[basename(write.file_path), write.content] as const]
  }))
  const found = NAMES.flatMap((name) => {
    const content = last.get(name)
    return content === undefined ? [] : [{ name, content }]
  })
  if (found.length < NAMES.length) {
    throw new Error(`${path}:${String(n)} has no Write for ${NAMES.filter((name) => !last.has(name)).join(' or ')}`)
  }
  return found.map(({ name, content }) => put(root, plan, name, content))
}

export function registerRestore(cf: Command, { root, out }: Cli): void {
  cf.command('restore').argument('<plan>').argument('<at>', '<transcript>:<line>')
    .action((plan: string, at: string) => { for (const path of restore(root, Number(plan), at)) out(`${path}\n`) })
}
