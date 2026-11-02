import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Read } from '../cli/gh.ts'
import { precedentsFor } from '../precedents/lookup.ts'
import { filed, type Precedent } from '../precedents/store.ts'
import { escapeCounts, escapesOf } from '../store/escapes.ts'
import type { Db } from '../store/index.ts'
import { flagged } from '../store/precedent-findings.ts'
import { profile } from '../store/profile.ts'
import { repoName } from './workspace.ts'

const fileOf = (area: string): string => area.replace(/:.*/s, '')

/** A rehearsal's `greptile.json`: reviews on request only, read against the target's documents and the rules on the job's files. */
export function config(db: Db, root: string, repo: string, files: string[], read: Read): string {
  const documents = (profile(root, repo)?.greptile_files ?? []).map((path) => ({ path, scope: ['**'] }))
  const stored = filed(db, repo)
  const latest = (p: Precedent): boolean => stored.some((s) => s.area === p.area && s.decision === p.decision && s.why === p.why
    && s.source === p.source && !stored.some((o) => o.area === s.area && o.merged_at > s.merged_at))
  const found: { file: string | undefined; rule: string }[] = [
    ...escapeCounts(db, repo).flatMap(({ number }) => escapesOf(db, repo, number))
      .map((e) => ({ file: e.area, rule: `${e.text.replace(/\s+/g, ' ')} (${e.url})` })),
    ...flagged(db, repo).filter((f) => f.acted_on !== 'ignored').map((f) => ({ file: fileOf(f.area), rule: `${f.finding} (${f.source})` })),
    ...(stored.length === 0 ? [] : precedentsFor(db, repo, files, read)).filter(latest)
      .map((p) => ({ file: fileOf(p.area), rule: `${p.decision}: ${p.why} (${p.source})` })),
    ...examples(root, repo).map((line) => ({ file: /^- \S+ `[^`@]+@\w+:([^`:]+)/.exec(line)?.[1], rule: line.slice(2) })),
  ]
  const rules = found.flatMap(({ file, rule }) => file !== undefined && files.includes(file) ? [{ rule, scope: [file] }] : [])
  return `${JSON.stringify({ autoReview: [], strictness: 1, customContext: { rules, files: documents } }, null, 2)}\n`
}

/** `config` as greptile.json, or its rules after theirs in `.greptile/config.json`, which Greptile reads instead where `dir` holds `.greptile/`. */
export function rehearsal(db: Db, root: string, repo: string, dir: string, files: string[], read: Read): Record<string, string> {
  const text = config(db, root, repo, files, read)
  if (!existsSync(join(dir, '.greptile'))) return { 'greptile.json': text }
  const at = join(dir, '.greptile', 'config.json')
  const theirs = (existsSync(at) ? JSON.parse(readFileSync(at, 'utf8')) : {}) as { rules?: unknown[] }
  const ours = (JSON.parse(text) as { customContext: { rules: unknown[] } }).customContext.rules
  return { '.greptile/config.json': `${JSON.stringify({ ...theirs, autoReview: [], rules: [...(theirs.rules ?? []), ...ours] }, null, 2)}\n` }
}

function examples(root: string, repo: string): string[] {
  return [join(root, 'reviews', 'examples'), join(root, '.cf', 'examples')]
    .flatMap((dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(join(dir, f), 'utf8')) : [])
    .flatMap((text) => text.split('\n').filter((line) => line.startsWith(`- ${repoName(repo)}#`)))
}
