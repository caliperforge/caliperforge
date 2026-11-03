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

const SOURCES = ['escapes', 'their reviewer', 'maintainer decisions', 'ours'] as const

/** A rehearsal's `greptile.json`: reviews on request only, read against the target's documents and the rules on the job's files; `counts` is its rules by source. */
export function config(db: Db, root: string, repo: string, files: string[], read: Read): { json: string; counts: string } {
  const documents = (profile(root, repo)?.greptile_files ?? []).map((path) => ({ path, scope: ['**'] }))
  const stored = filed(db, repo)
  const latest = (p: Precedent): boolean => stored.some((s) => s.area === p.area && s.decision === p.decision && s.why === p.why
    && s.source === p.source && !stored.some((o) => o.area === s.area && o.merged_at > s.merged_at))
  const found: { file: string | undefined; rule: string; source: typeof SOURCES[number] }[] = [
    ...escapeCounts(db, repo).flatMap(({ number }) => escapesOf(db, repo, number))
      .map((e) => ({ file: e.area, rule: `${e.text.replace(/\s+/g, ' ')} (${e.url})`, source: 'escapes' as const })),
    ...flagged(db, repo).filter((f) => f.acted_on !== 'ignored')
      .map((f) => ({ file: fileOf(f.area), rule: `${f.finding} (${f.source})`, source: 'their reviewer' as const })),
    ...(stored.length === 0 ? [] : precedentsFor(db, repo, files, read)).filter(latest)
      .map((p) => ({ file: fileOf(p.area), rule: `${p.decision}: ${p.why} (${p.source})`, source: 'maintainer decisions' as const })),
    ...examples(root, repo).map((line) => ({ file: /^- \S+ `[^`@]+@\w+:([^`:]+)/.exec(line)?.[1], rule: line.slice(2), source: 'ours' as const })),
  ]
  const kept = found.flatMap(({ file, rule, source }) => file !== undefined && files.includes(file) ? [{ rule, scope: [file], source }] : [])
  const rules = kept.map(({ rule, scope }) => ({ rule, scope }))
  return {
    json: `${JSON.stringify({ autoReview: [], strictness: 1, customContext: { rules, files: documents } }, null, 2)}\n`,
    counts: SOURCES.map((s) => `${s} ${String(kept.filter(({ source }) => source === s).length)}`).join(', '),
  }
}

/** `config` as greptile.json, or its rules after theirs in `.greptile/config.json`, which Greptile reads instead where `dir` holds `.greptile/`. */
export function rehearsal(db: Db, root: string, repo: string, dir: string, files: string[], read: Read): { files: Record<string, string>; counts: string } {
  const { json, counts } = config(db, root, repo, files, read)
  if (!existsSync(join(dir, '.greptile'))) return { files: { 'greptile.json': json }, counts }
  const at = join(dir, '.greptile', 'config.json')
  const theirs = (existsSync(at) ? JSON.parse(readFileSync(at, 'utf8')) : {}) as { rules?: unknown[] }
  const ours = (JSON.parse(json) as { customContext: { rules: unknown[] } }).customContext.rules
  return { files: { '.greptile/config.json': `${JSON.stringify({ ...theirs, autoReview: [], rules: [...(theirs.rules ?? []), ...ours] }, null, 2)}\n` }, counts }
}

function examples(root: string, repo: string): string[] {
  return [join(root, 'reviews', 'examples'), join(root, '.cf', 'examples')]
    .flatMap((dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(join(dir, f), 'utf8')) : [])
    .flatMap((text) => text.split('\n').filter((line) => line.startsWith(`- ${repoName(repo)}#`)))
}
