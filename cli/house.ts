import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Read } from './gh.ts'

export const SOURCES = /^sources:\n((?:.+\n)*)\n?/

const Blob = z.object({ sha: z.string() })

/** The house file's sources whose blob sha moved since it was written, as step 0's refusal note, or null. */
export function moved(root: string, repo: string, read: Read): string | null {
  const path = join(root, 'house', `${repo}.md`)
  const block = existsSync(path) ? SOURCES.exec(readFileSync(path, 'utf8'))?.[1] : undefined
  if (block === undefined) return null
  const changed = [...block.matchAll(/^- (\S+) (\S+) ([0-9a-f]{40})$/gm)].flatMap(([line, slug, file, sha]) => {
    const now = Blob.parse(read(['api', `repos/${String(slug)}/contents/${String(file)}`])).sha
    return now === sha ? [] : [`${line} -> ${now}`]
  })
  return changed.length === 0 ? null : `house-source-changed: Update house/${repo}.md: source changed\n${changed.join('\n')}`
}
