import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import { gh, type Read, WINDOW } from '../cli/gh.ts'
import { type Net, scan, type Scanned } from './scan.ts'

const REPO = 'solana-foundation/pay-skills'

const Open = z.array(z.object({ number: z.int(), headRefOid: z.string(), files: z.array(z.object({ path: z.string() })) }))
const Tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) })
const Blob = z.object({ content: z.string() })
const Doc = z.record(z.string(), z.unknown())
const Spec = z.object({ openapi: z.object({ path: z.string() }) })

export async function prs(root: string, out: string, cards: string | undefined, net: Net, read: Read = gh):
  Promise<{ prs: number; listings: Scanned[]; skipped: number[] }> {
  const base = join(root, '.cf', 'paydesk', 'prs')
  rmSync(base, { recursive: true, force: true })
  const open = Open.parse(read(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', String(WINDOW), '--json', 'number,headRefOid,files']))
  const folders: string[] = []
  const skipped: number[] = []
  for (const pr of open) {
    const blobs = new Map(Tree.parse(read(['api', `repos/${REPO}/git/trees/${pr.headRefOid}?recursive=1`])).tree
      .filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
    const dirs = [...blobs.keys()].filter((p) => posix.basename(p) === 'PAY.md').map((p) => posix.dirname(p))
      .filter((d) => pr.files.some((f) => f.path.startsWith(`${d}/`)))
    if (dirs.length === 0) skipped.push(pr.number)
    for (const d of dirs) folders.push(fetched(join(base, String(pr.number)), pr.number, d, blobs, read))
  }
  return { prs: open.length, listings: await scan(folders, out, cards, net), skipped }
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
