import { createHash } from 'node:crypto'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { gh, type Read } from '../cli/gh.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'

export const SERVER = 'github'

export const READ = `mcp__${SERVER}__read`

export const CAP = 100_000

const REPO = /^(?:https:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

const SHA = /^[0-9a-f]{40}$/

const Args = { repo: z.string(), sha: z.string(), path: z.string() }

const File = z.object({ size: z.number(), content: z.string() })

const Listing = z.array(z.object({ type: z.string(), path: z.string(), size: z.number() }))

interface Result { [key: string]: unknown; content: { type: 'text'; text: string }[]; isError?: boolean }

export function pinned(db: Db, plan: number, args: { repo: string; sha: string; path: string }, read: Read = gh): Result {
  const slug = REPO.exec(args.repo)?.[1]
  if (slug === undefined) return refused(`${args.repo} is not github.com/<owner>/<repo>`)
  if (!SHA.test(args.sha)) return refused(`${args.sha} is not a 40-hex commit sha`)
  const encoded = args.path.split('/').map(encodeURIComponent).join('/')
  let got: Buffer
  try {
    got = body(read(['api', `repos/${slug}/contents/${encoded}?ref=${args.sha}`]))
  } catch (e) {
    return refused((e as Error).message)
  }
  const sha256 = createHash('sha256').update(got).digest('hex')
  logged(db, { plan, kind: 'github_read', actor: 'brief_writer', outcome: 'pass', run: null,
    message: `${slug}@${args.sha} ${args.path} ${String(got.length)} bytes sha256 ${sha256}`,
    pointer: `https://github.com/${slug}/blob/${args.sha}/${args.path}` })
  return { content: [{ type: 'text', text: got.toString('utf8') }] }
}

export function server(db: Db, plan: number, read: Read = gh): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: SERVER, tools: [tool('read',
    'One file, or one directory listing, from a public github.com repo at a 40-hex commit sha.',
    Args, (args) => Promise.resolve(pinned(db, plan, args, read)))] })
}

function body(got: unknown): Buffer {
  if (Array.isArray(got)) return Buffer.from(Listing.parse(got).map((e) => `${e.type}\t${e.path}\t${String(e.size)}`).join('\n'))
  const file = File.parse(got)
  if (file.size > CAP) throw new Error(`the file is ${String(file.size)} bytes, over the ${String(CAP)} cap`)
  return Buffer.from(file.content.replace(/\n/g, ''), 'base64')
}

function refused(why: string): Result {
  return { content: [{ type: 'text', text: why }], isError: true }
}
