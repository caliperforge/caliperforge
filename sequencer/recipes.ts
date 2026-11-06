import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Gate } from './gates.ts'

const RUST_TESTS = ['rust-test', 'test-rust']

const RECIPE_FILE = /^(?:justfile|makefile)$/i

/** The nearest folder at or above the file's own that holds a marker; the root when none does. */
export function home(src: string, file: string, marks: (name: string, here: string) => boolean): string {
  let dir = dirname(file)
  for (;;) {
    const here = join(src, dir === '.' ? '' : dir)
    if (existsSync(here) && readdirSync(here).some((n) => marks(n, here))) return dir === '.' ? '' : dir
    if (dir === '.' || dir === '') return ''
    dir = dirname(dir)
  }
}

/** A Justfile's recipe names, or null when there is none. */
export function recipes(path: string): Set<string> | null {
  if (!existsSync(path)) return null
  const names = [...readFileSync(path, 'utf8').matchAll(/^@?([A-Za-z_][\w-]*)(?:[ \t][^:\n]*)?:(?!=)/gm)].map((m) => m[1] ?? '')
  return new Set(names)
}

/** Their first `rust-test` or `test-rust` recipe, then `<recipe>-<folder>` for each folder of the `.rs` files that defines one. */
export function tested(src: string, files: string[]): Gate[] {
  const dir = home(src, files[0] ?? '', (n, here) => RECIPE_FILE.test(n) && RUST_TESTS.some((r) => recipes(join(here, n))?.has(r) === true))
  const found = readdirSync(join(src, dir)).filter((n) => RECIPE_FILE.test(n))
  const name = found.find((n) => /^justfile$/i.test(n)) ?? found[0]
  if (name === undefined) return []
  const defined = recipes(join(src, dir, name)) ?? new Set<string>()
  const test = RUST_TESTS.find((r) => defined.has(r))
  if (test === undefined) return []
  const named = [test, ...files.flatMap((f) => dirname(f).split('/').map((s) => `${test}-${s}`))].filter((r, at, all) => defined.has(r) && all.indexOf(r) === at)
  return named.map((r) => (/^justfile$/i.test(name) ? { script: 'test', bin: 'just', args: ['--justfile', name, r], dir } : { script: 'test', bin: 'make', args: [r], dir }))
}
