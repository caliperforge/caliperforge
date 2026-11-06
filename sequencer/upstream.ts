import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { gh, type Read } from '../cli/gh.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { section } from './brief.ts'
import type { Outcome } from './kind.ts'
import { get, srcDir } from './workspace.ts'

export const SERVER = 'github'

export const READ = `mcp__${SERVER}__read`

export const CAP = 100_000

const REPO = /^(?:https:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

const SHA = /^[0-9a-f]{40}$/

const ROW = /^- `([^`]+)` — ([^@\s]+)@(\S+) (\S+)$/

const Args = { repo: z.string(), sha: z.string(), path: z.string() }

const File = z.object({ size: z.number(), content: z.string() })

const Listing = z.array(z.object({ type: z.string(), path: z.string(), size: z.number() }))

interface Result { [key: string]: unknown; content: { type: 'text'; text: string }[]; isError?: boolean }

export function pinned(db: Db, plan: number, args: { repo: string; sha: string; path: string }, read: Read = gh,
  actor = 'brief_writer'): Result {
  try {
    return { content: [{ type: 'text', text: fetched(db, plan, args, read, actor, true).toString('utf8') }] }
  } catch (e) {
    return refused((e as Error).message)
  }
}

export function vendored(db: Db, root: string, plan: number, read: Read = gh): Outcome | null {
  const files: [string, Buffer][] = []
  for (const row of section(get(root, plan, 'issue.md'), '## Vendored').split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const [, path = '', repo = '', sha = '', from = ''] = ROW.exec(row) ?? []
      if (from === '') throw new Error('not - `<checkout path>` — github.com/<owner>/<repo>@<sha> <path>')
      if (isAbsolute(path) || path.split('/').includes('..')) throw new Error(`${path} leaves the checkout`)
      files.push([join(srcDir(root, plan), path), fetched(db, plan, { repo, sha, path: from }, read, 'machine', false)])
    } catch (e) {
      const note = `vendor: ${row}: ${(e as Error).message}`
      logged(db, { plan, kind: 'vendor', actor: 'machine', outcome: 'needs_ceo', message: note, pointer: null, run: null })
      return { outcome: 'needs_ceo', spans: [row], note }
    }
  }
  files.forEach(([to, got]) => { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, got) })
  return null
}

export function server(db: Db, plan: number, actor = 'brief_writer', read: Read = gh): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: SERVER, tools: [tool('read',
    'One file, or one directory listing, from a public github.com repo at a 40-hex commit sha.',
    Args, (args) => Promise.resolve(pinned(db, plan, args, read, actor)))] })
}

function fetched(db: Db, plan: number, args: { repo: string; sha: string; path: string }, read: Read, actor: string,
  listing: boolean): Buffer {
  const slug = REPO.exec(args.repo)?.[1]
  if (slug === undefined) throw new Error(`${args.repo} is not github.com/<owner>/<repo>`)
  if (!SHA.test(args.sha)) throw new Error(`${args.sha} is not a 40-hex commit sha`)
  const encoded = args.path.split('/').map(encodeURIComponent).join('/')
  const got = body(read(['api', `repos/${slug}/contents/${encoded}?ref=${args.sha}`]), listing)
  const sha256 = createHash('sha256').update(got).digest('hex')
  logged(db, { plan, kind: 'github_read', actor, outcome: 'pass', run: null,
    message: `${slug}@${args.sha} ${args.path} ${String(got.length)} bytes sha256 ${sha256}`,
    pointer: `https://github.com/${slug}/blob/${args.sha}/${args.path}` })
  return got
}

function body(got: unknown, listing: boolean): Buffer {
  if (Array.isArray(got) && !listing) throw new Error('a directory listing, not a file')
  if (Array.isArray(got)) return Buffer.from(Listing.parse(got).map((e) => `${e.type}\t${e.path}\t${String(e.size)}`).join('\n'))
  const file = File.parse(got)
  if (file.size > CAP) throw new Error(`the file is ${String(file.size)} bytes, over the ${String(CAP)} cap`)
  return Buffer.from(file.content.replace(/\n/g, ''), 'base64')
}

function refused(why: string): Result {
  return { content: [{ type: 'text', text: why }], isError: true }
}
