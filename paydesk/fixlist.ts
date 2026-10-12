import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { parse } from 'yaml'

export interface Row { pr: number; listing: string; method?: string; path?: string; msg: string; range?: [number, number]; length?: number }

const LINE = /^- (\S+): (?:([A-Z]+) (\S+): )?(.*)$/
const RANGES: Record<string, [number, number]> = { summary: [24, 63], description: [64, 255], use_case: [32, 255] }

export function rows(stderr: string, pr: number, root: string): Row[] {
  return stripVTControlCharacters(stderr).split('\n').flatMap((line) => {
    const [, listing = '', method, path, msg = ''] = LINE.exec(line) ?? []
    if (listing === '' || msg.startsWith('PASS')) return []
    return [sized({ pr, listing, ...(method === undefined ? {} : { method }), ...(path === undefined ? {} : { path }), msg }, root)]
  })
}

function sized(row: Row, root: string): Row {
  const found = /length|characters/i.test(row.msg) ? Object.entries(RANGES).find(([f]) => new RegExp(`\\b${f}\\b`, 'i').test(row.msg)) : undefined
  if (found === undefined) return row
  const [field, range] = found
  const front = parse(readFileSync(join(root, row.listing, 'PAY.md'), 'utf8').split(/^---$/m)[1] ?? '') as Record<string, unknown> | null
  const value = front?.[field]
  return { ...row, range, length: typeof value === 'string' ? Array.from(value).length : 0 }
}
