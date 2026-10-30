import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { inline, type Read } from '../cli/gh.ts'
import { profile } from '../store/profile.ts'

const BOT = 'greptile-apps[bot]'

const WEEK = 7 * 86_400_000

const NAMES = ['rules.md', 'config.json']

const DOCS: [string, string[]][] = [
  ['Contributing', ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md']],
  ['Pull request template', ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']],
]

const Listed = z.array(z.object({ number: z.int(), statusCheckRollup: z.array(z.looseObject({ name: z.string().optional() })).nullable() }))

interface Finding { title: string; text: string; badge: number; topics: string[] }

/** A target's own Greptile rules as `.greptile/` files, harvested at most once a week; null when the target runs no Greptile. */
export function mirrored(root: string, repo: string, dir: string, read: Read, now = new Date()): Record<string, string> | null {
  const cache = join(root, '.cf', 'greptile', repo)
  const at = join(cache, 'at')
  const then = existsSync(at) ? Date.parse(readFileSync(at, 'utf8')) : null
  if (Number.isNaN(then)) throw new Error(`${at} holds no ISO time`)
  if (then !== null && now.getTime() - then < WEEK) return cached(cache)
  const files = harvest(root, repo, dir, read)
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })
  for (const [path, text] of Object.entries(files ?? {})) writeFileSync(join(cache, basename(path)), text)
  writeFileSync(at, now.toISOString())
  return files
}

function cached(cache: string): Record<string, string> | null {
  if (!existsSync(join(cache, 'rules.md'))) return null
  return Object.fromEntries(NAMES.map((name) => [`.greptile/${name}`, readFileSync(join(cache, name), 'utf8')]))
}

function harvest(root: string, repo: string, dir: string, read: Read): Record<string, string> | null {
  const listed = Listed.parse(read(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '30', '--json', 'number,statusCheckRollup']))
  const bodies = listed.flatMap((p) => inline(repo, p.number, read)).filter((c) => c.user.login === BOT).map((c) => c.body)
  if (bodies.length === 0 && !listed.some((p) => p.statusCheckRollup?.some((r) => r.name === 'Greptile Review') === true)) return null
  const found = bodies.flatMap(finding)
  return { '.greptile/rules.md': rules(repo, dir, found), '.greptile/config.json': settings(root, repo, found) }
}

function finding(body: string): Finding[] {
  const lines = body.split('\n')
  const at = lines.findIndex((l) => /alt="P\d+"/.test(l))
  const badged = /alt="P(\d+)".*?\*\*(.+?)\*\*/.exec(lines[at] ?? '')
  if (badged === null) return []
  const text = lines.slice(at + 1).join('\n').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p !== '') ?? ''
  const kb = lines.find((l) => l.startsWith('**Knowledge Base Used:**')) ?? ''
  return [{ title: badged[2] ?? '', text: text.replace(/\s+/g, ' '), badge: Number(badged[1]), topics: [...kb.matchAll(/\[([^\]]+)\]\(/g)].map((m) => m[1] ?? '') }]
}

function rules(repo: string, dir: string, found: Finding[]): string {
  const topics = [...new Set(found.flatMap((f) => f.topics))].sort((a, b) => a.localeCompare(b))
  const groups: [string, Finding[]][] = [...topics.map((t): [string, Finding[]] => [t, found.filter((f) => f.topics.includes(t))]),
    ['Other findings', found.filter((f) => f.topics.length === 0)]]
  const docs = DOCS.flatMap(([heading, paths]) => {
    const path = paths.find((p) => existsSync(join(dir, p)))
    return path === undefined ? [] : [`## ${heading}\n\n${readFileSync(join(dir, path), 'utf8').trim()}`]
  })
  return `${[`# Review rules for ${repo}, from its own Greptile reviews`,
    ...groups.filter(([, fs]) => fs.length > 0).map(([topic, fs]) => `## ${topic}\n\n${rows(fs).join('\n')}`), ...docs].join('\n\n')}\n`
}

function rows(found: Finding[]): string[] {
  const by = new Map<string, { text: string; badge: number; count: number }>()
  for (const f of found) {
    const was = by.get(f.title)
    by.set(f.title, { text: was?.text ?? f.text, badge: Math.min(was?.badge ?? f.badge, f.badge), count: (was?.count ?? 0) + 1 })
  }
  return [...by].sort(([, a], [, b]) => b.count - a.count)
    .map(([title, r]) => `- ${title} (P${String(r.badge)}, ${String(r.count)}×): ${r.text}`)
}

function settings(root: string, repo: string, found: Finding[]): string {
  const files = (profile(root, repo)?.greptile_files ?? []).map((path) => ({ path, scope: ['**'] }))
  const least = Math.max(...found.map((f) => f.badge))
  const strictness = found.length === 0 || least === 2 ? 2 : least > 2 ? 1 : 3
  return `${JSON.stringify({ autoReview: [], strictness, customContext: { files } }, null, 2)}\n`
}
