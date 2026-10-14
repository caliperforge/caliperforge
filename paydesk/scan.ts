import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { assess, usable, type EndpointVerdict, type Probe } from './assess.ts'
import { bodyCandidates, type Operation, type Spec } from './body.ts'
import { card, listingFlags, type ListingScan } from './card.ts'
import { offersOf } from './offers.ts'
import { payee } from './payee.ts'
import { declaredUsd, pathMatches, type Pricing } from './price.ts'

export interface Net { fetch: typeof fetch; resolve: (host: string) => Promise<unknown> }
export type Scanned = ListingScan | { fqn: string; crash: string }

type Op = Operation & { operationId?: string } & Record<string, unknown>
type OpenApi = Spec & { paths?: Record<string, Partial<Record<(typeof METHODS)[number], Op>>> }
interface Listed { method: string; path: string; op: Op }
type Send = (url: string, method: string, body: unknown) => Promise<Response>
type Owes = ReturnType<typeof payee>

const WORKERS = 6
const CAP = 60
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const OUTBOUND = ['send', 'sms', 'email', 'mail', 'tweet', 'post', 'publish', 'message', 'notify', 'call', 'transfer', 'withdraw']
const WORDS = /[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/
const AGENT = 'pay-catalog-scanner/0.1 (+caliperforge)'

const Front = z.object({
  service_url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  use_case: z.string().optional(),
  pr: z.int().default(0),
  openapi: z.object({ path: z.string() }),
  endpoints: z.array(z.object({
    pricing: z.object({
      dimensions: z.array(z.object({
        scale: z.number().exactOptional(),
        tiers: z.array(z.object({ price_usd: z.number() })).exactOptional(),
      })).exactOptional(),
    }).exactOptional(),
  })).optional(),
})

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function scan(dirs: string[], out: string | undefined, cards: string | undefined, net: Net): Promise<Scanned[]> {
  const listed = dirs.filter((dir) => existsSync(join(dir, 'PAY.md')))
  const results: Scanned[] = []
  const owes = payee(net.fetch)
  let next = 0
  const work = async (): Promise<void> => {
    for (let dir = listed[next]; dir !== undefined; dir = listed[next]) {
      const i = next++
      const fqn = fqnOf(dir)
      results[i] = await listing(dir, net, owes).then((s): Scanned => s, (e: unknown) => ({ fqn, crash: message(e) }))
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, work))
  if (out !== undefined) writeFileSync(out, JSON.stringify(results, null, 2))
  if (cards !== undefined) {
    mkdirSync(cards, { recursive: true })
    for (const s of results) if (!('crash' in s)) writeFileSync(join(cards, `${s.fqn.replace('/', '__')}.md`), card(s))
  }
  return results
}

function fqnOf(dir: string): string {
  const abs = resolve(dir)
  return `${basename(dirname(abs))}/${basename(abs)}`
}

function front(dir: string): z.infer<typeof Front> {
  const path = join(dir, 'PAY.md')
  const found = Front.safeParse(parse(readFileSync(path, 'utf8').split(/^---$/m)[1] ?? ''))
  if (!found.success) throw new Error(`${path}: ${found.error.message}`)
  return found.data
}

async function listing(dir: string, net: Net, owes: Owes): Promise<ListingScan> {
  const pay = front(dir)
  const spec = JSON.parse(readFileSync(resolve(dir, pay.openapi.path), 'utf8')) as OpenApi
  const host = new URL(pay.service_url).hostname
  const dns = await net.resolve(host).then(() => true, () => false)
  const ops = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    METHODS.flatMap((m) => { const op = item[m]; return op === undefined ? [] : [{ method: m.toUpperCase(), path, op }] }))
  const kept = ops.slice(0, CAP).filter((o) => o.method === 'GET' || !outbound(o))
  const send = sender(net)
  const base = pay.service_url.replace(/\/+$/, '')
  const pricing: Pricing | undefined = pay.endpoints?.[0]?.pricing
  const endpoints: ListingScan['endpoints'] = []
  for (const o of kept) {
    const path = o.path.replace(/\{[^}]+\}/g, 'test')
    const probe = await tried(send, base + path, o.method, o.method === 'GET' ? [null] : bodyCandidates(o.op, spec))
    const declared = declaredUsd((ops.find((s) => s.method === o.method && pathMatches(s.path, path)) ?? o).op, pricing)
    endpoints.push({ ...await owed(assess(probe, declared, host), probe, owes), method: o.method, path: o.path })
  }
  return { pr: pay.pr, fqn: fqnOf(dir), title: pay.title, serviceUrl: pay.service_url, host, dns,
    ...listingFlags(host, [pay.title, pay.description, pay.use_case].join('\n')), nOps: ops.length, nScanned: endpoints.length, endpoints }
}

async function owed(assessed: EndpointVerdict, probe: Probe, owes: Owes): Promise<EndpointVerdict> {
  if ('error' in probe || (assessed.verdict !== 'ok' && assessed.verdict !== 'warn')) return assessed
  const issues = await owes(usable(probe.offers.offers))
  return issues.length === 0 ? assessed : { ...assessed, verdict: 'warn', issues: [...assessed.issues, ...issues] }
}

function outbound({ path, op }: Listed): boolean {
  return `${path} ${op.operationId ?? ''}`.split(WORDS).some((w) => OUTBOUND.includes(w.toLowerCase()))
}

function sender(net: Net): Send {
  let sent = 0
  return async (url, method, body) => {
    if (sent++ > 0) await sleep(250)
    const init = { method, redirect: 'manual', signal: AbortSignal.timeout(15_000) } as const
    return method === 'GET'
      ? net.fetch(url, { ...init, headers: { 'user-agent': AGENT } })
      : net.fetch(url, { ...init, headers: { 'user-agent': AGENT, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
}

async function tried(send: Send, url: string, method: string, bodies: unknown[]): Promise<Probe> {
  const [body, ...rest] = bodies
  const probe = await answer(send(url, method, body))
  return rest.length === 0 || ('status' in probe && probe.status === 402) ? probe : tried(send, url, method, rest)
}

async function answer(sent: Promise<Response>): Promise<Probe> {
  return sent.then(async (res) => ({
    status: res.status,
    offers: offersOf({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }),
    bodyIsJson: (res.headers.get('content-type') ?? '').includes('json'),
  })).catch((e: unknown) => ({ error: message(e) }))
}
