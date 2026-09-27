import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { subdirs, walk } from '../checks/tree.ts'

const RESTART = 'Restarting after unexpected exit, crash, or test timeout'

const NAMED = /^\s+(\w+)\.\w+\(\)\s*$/

/** The test host exited, and every class it names as failing is declared in a `.swift` file the diff does not touch. */
export function exitedOutside(src: string, output: string, touched: string[]): boolean {
  if (!output.includes(RESTART)) return false
  const classes = failing(output)
  if (classes.length === 0) return false
  const swift = subdirs(src).filter((dir) => !dir.startsWith('.'))
    .flatMap((dir) => walk(join(src, dir), (name) => name.endsWith('.swift')))
  return classes.every((name) => {
    const home = swift.find((path) => new RegExp(`\\bclass ${name}\\b`).test(readFileSync(path, 'utf8')))
    return home !== undefined && !touched.includes(relative(src, home))
  })
}

function failing(output: string): string[] {
  const lines = output.split('\n')
  const at = lines.findIndex((line) => line.trim() === 'Failing tests:')
  if (at < 0) return []
  const under = lines.slice(at + 1)
  const end = under.findIndex((line) => !/^\s/.test(line))
  return [...new Set(under.slice(0, end < 0 ? undefined : end).map((line) => NAMED.exec(line)?.[1]).filter((name) => name !== undefined))]
}
