import { stripVTControlCharacters } from 'node:util'
import { walk } from '../checks/tree.ts'

/** vitest prints a test file only once it finishes, so the files missing from the output were still running or queued when the cap fired. */
export function unfinished(src: string, output: string): string[] {
  const plain = stripVTControlCharacters(output)
  return walk(src, (name) => name.endsWith('.test.ts')).map((path) => path.slice(src.length + 1)).filter((path) => !plain.includes(` ${path} (`))
}
