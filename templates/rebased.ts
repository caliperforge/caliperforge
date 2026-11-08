import { isAbsolute } from 'node:path'

/** run_pair installs the suite at `test/<target>/` and Medusa resolves from the config's folder; fizz wrote these from the project root. */
const MOVED: [string[], string][] = [[['fuzzing'], 'corpusDirectory'], [['logging'], 'logDirectory'],
  [['compilation', 'platformConfig'], 'target'], [['compilation', 'platformConfig'], 'exportDirectory'], [['slither'], 'cachePath']]

export function rebased(config: unknown, to: (path: string) => string): void {
  for (const [keys, key] of MOVED) {
    const parent = keys.reduce(field, config)
    const value = field(parent, key)
    if (typeof value === 'string' && value !== '' && !isAbsolute(value)) Object.assign(parent as object, { [key]: to(value) })
  }
}

export function field(tree: unknown, key: string): unknown {
  return typeof tree === 'object' && tree !== null ? (tree as Record<string, unknown>)[key] : undefined
}
