import { z } from 'zod'
import { paced, sender } from '../../precedents/mismatch.ts'
import type { Reply } from '../../precedents/rpc.ts'

type Pair = [string, string]

const Repeat = z.strictObject({ repeat: z.json(), times: z.int().positive() }).transform(({ repeat, times }) => Array<unknown>(times).fill(repeat))

export const Cases = z.array(z.object({ method: z.string(), case: z.string(), params: z.array(z.union([Repeat, z.unknown()])),
  compare: z.union([z.literal('error'), z.literal('shape'), z.literal('value')]) }))

type Case = z.output<typeof Cases>[number]

const Slotted = z.array(z.looseObject({ slot: z.int() }))

const kind = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

const said = (reply: Reply): string => 'error' in reply ? `${String(reply.error.code)} ${reply.error.message}` : 'result'

const pair = (real: string, surfnet: string): Pair | undefined => real === surfnet ? undefined : [real, surfnet]

function repeated(list: unknown[]): number | undefined {
  const slotted = Slotted.safeParse(list)
  const slots = slotted.success ? slotted.data.map((e) => e.slot) : []
  return slots.find((slot, i) => slots.indexOf(slot) !== i)
}

const counted = (path: string, list: unknown[], slot: number | undefined): string =>
  slot === undefined ? `${path} length ${String(list.length)}` : `${path} repeats slot ${String(slot)}`

function listed(path: string, real: unknown[], surfnet: unknown[]): Pair | undefined {
  const slots = [repeated(real), repeated(surfnet)]
  if ((slots[0] === undefined) !== (slots[1] === undefined)) return [counted(path, real, slots[0]), counted(path, surfnet, slots[1])]
  if (real.length !== surfnet.length) return [counted(path, real, undefined), counted(path, surfnet, undefined)]
  for (const [i, value] of real.entries()) {
    const found = walked(`${path}[${String(i)}]`, value, surfnet[i])
    if (found !== undefined) return found
  }
  return undefined
}

const held = (path: string, object: Record<string, unknown>, key: string): string => key in object ? `${path} ${kind(object[key])}` : `${path} absent`

function keyed(path: string, real: Record<string, unknown>, surfnet: Record<string, unknown>): Pair | undefined {
  const keys = [...new Set([...Object.keys(real), ...Object.keys(surfnet)])]
  const missing = keys.find((key) => !(key in real) || !(key in surfnet))
  if (missing !== undefined) return [held(`${path}.${missing}`, real, missing), held(`${path}.${missing}`, surfnet, missing)]
  for (const key of keys) {
    const found = walked(`${path}.${key}`, real[key], surfnet[key])
    if (found !== undefined) return found
  }
  return undefined
}

function walked(path: string, real: unknown, surfnet: unknown): Pair | undefined {
  if (kind(real) !== kind(surfnet)) return [`${path} ${kind(real)}`, `${path} ${kind(surfnet)}`]
  if (Array.isArray(real) && Array.isArray(surfnet)) return listed(path, real, surfnet)
  return kind(real) === 'object' ? keyed(path, real as Record<string, unknown>, surfnet as Record<string, unknown>) : undefined
}

function differs(compare: Case['compare'], real: Reply, surfnet: Reply): Pair | undefined {
  if (compare === 'error' || 'error' in real || 'error' in surfnet) return pair(said(real), said(surfnet))
  if (compare === 'value') return pair(JSON.stringify(real.result), JSON.stringify(surfnet.result))
  return walked('$', real.result, surfnet.result)
}

export async function probe(cases: Case[], sides: { real: string; surfnet: string }, gap: number): Promise<{ rows: string[]; matched: number }> {
  const [real, surfnet] = [paced(sender(sides.real), gap), sender(sides.surfnet)]
  const rows: string[] = []
  for (const c of cases) {
    const found = differs(c.compare, await real(c), await surfnet(c))
    if (found !== undefined) rows.push([c.method, c.case, ...found].join('\t'))
  }
  return { rows, matched: cases.length - rows.length }
}
