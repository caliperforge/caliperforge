import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import type { Read } from '../cli/gh.ts'
import { verdict } from './live.ts'
import { fqnOf, type Net, scan, type Scanned } from './scan.ts'

const REPO = 'solana-foundation/pay-skills'
const PAGE = 100

const Open = z.array(z.object({ number: z.int(), headRefOid: z.string() }))
const Files = z.array(z.object({ filename: z.string() }))
const Tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) })
const Blob = z.object({ content: z.string() })
const Doc = z.record(z.string(), z.unknown())
const Spec = z.object({ openapi: z.object({ path: z.string() }) })

export interface Unfetched { pr: number; unfetched: string }
export type Row = Scanned | Unfetched
type Noted = Scanned & { note?: string }

const buffered: Read = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as unknown

export async function prs(root: string, out: string, cards: string | undefined, net: Net, raw: Read = buffered, since?: string):
  Promise<{ prs: number; listings: Noted[]; unfetched: Unfetched[]; skipped: number[] }> {
  const read = retried(raw)
  const base = join(root, '.cf', 'paydesk', 'prs')
  rmSync(base, { recursive: true, force: true })
  const open = Open.parse(read(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,headRefOid']))
  const folders: { dir: string; pr: number }[] = []
  const unfetched: Unfetched[] = []
  const skipped: number[] = []
  for (const pr of open) {
    const got = await Promise.resolve().then(() => listed(pr.number, pr.headRefOid, read))
      .catch((e: unknown): Unfetched => ({ pr: pr.number, unfetched: e instanceof Error ? e.message : String(e) }))
    if ('unfetched' in got) {
      unfetched.push(got)
      continue
    }
    const dirs = [...got.blobs.keys()].filter((p) => posix.basename(p) === 'PAY.md').map((p) => posix.dirname(p))
      .filter((d) => got.files.some((f) => f.startsWith(`${d}/`)))
    if (dirs.length === 0) skipped.push(pr.number)
    for (const d of dirs) folders.push({ dir: fetched(join(base, String(pr.number)), pr.number, d, got.blobs, read), pr: pr.number })
  }
  const scanned = await scan(folders.map((f) => f.dir), undefined, cards, net)
  const listings = scanned.map((s, i) => ('invalid_listing' in s ? { ...s, pr: folders[i]?.pr ?? s.pr } : s))
  const noted = since === undefined ? listings : await rechecked(since, listings, folders.map((f) => f.dir), cards, net)
  writeFileSync(out, JSON.stringify([...noted, ...unfetched], null, 2))
  if (cards !== undefined) {
    for (const u of unfetched) writeFileSync(join(cards, `pr-${String(u.pr)}.md`), `## #${String(u.pr)}: files not fetched\n\n${u.unfetched}\n`)
  }
  return { prs: open.length, listings: noted, unfetched, skipped }
}

async function rechecked(since: string, listings: Scanned[], dirs: string[], cards: string | undefined, net: Net): Promise<Noted[]> {
  const passed = new Map((JSON.parse(readFileSync(since, 'utf8')) as Row[]).flatMap((r) => ('fqn' in r && verdict(r) === 'pass' ? [[r.fqn, r] as const] : [])))
  const date = statSync(since).mtime.toISOString().slice(0, 10)
  const flipped = new Set(listings.filter((s) => passed.has(s.fqn) && ['reject', 'crash'].includes(verdict(s))).map((s) => s.fqn))
  const again = new Map((await scan(dirs.filter((d) => flipped.has(fqnOf(d))), undefined, cards, net)).map((s) => [s.fqn, s]))
  return listings.map((s) => {
    const was = passed.get(s.fqn)
    const second = again.get(s.fqn)
    if (was === undefined || second === undefined) return s
    return verdict(second) === 'pass' ? { ...was, note: `blip: ${verdict(s)}` } : { ...second, note: `flipped since ${date}` }
  })
}

function retried(read: Read): Read {
  return (args) => {
    try {
      return read(args)
    } catch (e) {
      if (!/HTTP 5\d\d/.test(String(e))) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
      return read(args)
    }
  }
}

function listed(pr: number, head: string, read: Read): { files: string[]; blobs: Map<string, string> } {
  const files = changed(pr, read)
  const blobs = new Map(Tree.parse(read(['api', `repos/${REPO}/git/trees/${head}?recursive=1`])).tree
    .filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
  return { files, blobs }
}

function changed(pr: number, read: Read): string[] {
  const files: string[] = []
  for (let p = 1; ; p++) {
    const page = Files.parse(read(['api', `repos/${REPO}/pulls/${String(pr)}/files?per_page=${String(PAGE)}&page=${String(p)}`]))
    files.push(...page.map((f) => f.filename))
    if (page.length < PAGE) return files
  }
}

function fetched(into: string, pr: number, dir: string, blobs: Map<string, string>, read: Read): string {
  const blob = (path: string): string =>
    Buffer.from(Blob.parse(read(['api', `repos/${REPO}/git/blobs/${blobs.get(path) ?? ''}`])).content, 'base64').toString('utf8')
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(into, path)), { recursive: true })
    writeFileSync(join(into, path), text)
  }
  const pay = blob(posix.join(dir, 'PAY.md'))
  const [before = '', head = '', ...rest] = pay.split(/^---$/m)
  const doc = Doc.safeParse(yamlOf(head))
  if (!doc.success) {
    put(posix.join(dir, 'PAY.md'), pay)
    return join(into, dir)
  }
  doc.data.pr = pr
  put(posix.join(dir, 'PAY.md'), `${before}---\n${stringify(doc.data)}---${rest.join('---')}`)
  const spec = Spec.safeParse(doc.data)
  const path = spec.success ? posix.join(dir, spec.data.openapi.path) : undefined
  if (path !== undefined && blobs.has(path)) put(path, blob(path))
  return join(into, dir)
}

function yamlOf(text: string): unknown {
  const doc = parseDocument(text)
  return doc.errors.length === 0 ? doc.toJS() : undefined
}
