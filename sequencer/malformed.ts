import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Failure } from './checks.ts'

/** The first touched JSON file that does not parse; tsconfig files are tsc's to read, and allow comments. */
export function malformed(src: string, touched: string[]): Failure | null {
  for (const path of touched.filter((p) => p.endsWith('.json') && !basename(p).startsWith('tsconfig') && existsSync(join(src, p)))) {
    try {
      JSON.parse(readFileSync(join(src, path), 'utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return { script: 'json', command: `JSON.parse ${path}`, code: '1', output: `${path}: ${error.message}`, tests: [], retried: false }
    }
  }
  return null
}
