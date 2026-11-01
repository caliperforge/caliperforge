import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from '../checks/tree.ts'
import { files, section, type Refused } from './brief.ts'
import { EXPORTED } from './symbols.ts'

const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/

const FILE = /\.[a-z]{1,4}$/

const MEMBER = /^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/

const TS = /\.tsx?$/

interface Hit {
  exported: string
  cite: string
  line: number
}

const declared = (line: string): string[] => [EXPORTED.exec(line)?.[1], MEMBER.exec(line)?.[1]].flatMap((n) => n ?? [])

/** A TypeScript brief whose ## Approach or ## Cases names a dependency's export cites that export's `.d.ts` line under ## Settled facts. */
export function settled(brief: string, src: string): Refused | null {
  if (!existsSync(join(src, 'package.json')) || !files(brief).some((f) => TS.test(f.path))) return null
  const tokens = [section(brief, '## Approach'), section(brief, '## Cases')]
    .flatMap((text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => String(m[1])))
    .filter((t) => NAME.test(t) && !FILE.test(t))
  if (tokens.length === 0) return null
  const ours = new Set(walk(src, (f) => TS.test(f)).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap(declared)))
  const facts = section(brief, '## Settled facts').split('\n')
  for (const token of tokens) {
    const name = token.replace(/\(\)$/, '').replace(/^.*\./, '')
    const hit = ours.has(name) ? null : definition(src, name)
    if (hit === null || facts.some((l) => cites(l, hit) && (l.includes(hit.exported) || l.includes(name)))) continue
    return { span: token, reason: `${token} is ${hit.exported} at ${hit.cite}:${String(hit.line)}, cited nowhere under ## Settled facts; paste that definition there` }
  }
  return null
}

const cites = (line: string, hit: Hit): boolean => line.split(`${hit.cite}:`).slice(1).some((after) => /^\d/.test(after))

function definition(src: string, name: string): Hit | null {
  const { dependencies = {}, devDependencies = {} } =
    JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
  for (const pkg of Object.keys({ ...dependencies, ...devDependencies })) {
    const root = join(src, 'node_modules', pkg)
    for (const path of walk(root, (f) => f.endsWith('.d.ts')).sort()) {
      const hit = inFile(readFileSync(path, 'utf8'), name)
      if (hit !== null) return { ...hit, cite: `node_modules/${pkg}/${relative(root, path)}` }
    }
  }
  return null
}

/** The first line declaring `name` under an export, and that export: the nearest line at or above it the export pattern captures. */
function inFile(text: string, name: string): Omit<Hit, 'cite'> | null {
  let exported: Omit<Hit, 'cite'> | null = null
  for (const [i, line] of text.split('\n').entries()) {
    const named = EXPORTED.exec(line)?.[1]
    if (named !== undefined) exported = { exported: named, line: i + 1 }
    if (exported !== null && declared(line).includes(name)) return exported
  }
  return null
}
