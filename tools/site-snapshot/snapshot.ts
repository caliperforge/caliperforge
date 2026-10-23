import { z } from 'zod'

export interface Tls { issuer: string; expires: string }
export interface Net { fetch: typeof fetch; tls: (host: string) => Promise<Tls>; ns: (host: string) => Promise<string[]> }
export interface Named { name: string; version: string | null }

export interface Read {
  generator: Named | null
  plugins: Named[]
  themes: Named[]
  php: string | null
  server: string | null
  headers: { hsts: boolean; csp: boolean; frameOptions: boolean }
  cloudflare: boolean
}

export interface Snapshot extends Read {
  url: string
  final: string
  status: number
  tls: Tls | null
  nameservers: string[] | null
  cloudflareDns: boolean | null
  latestWordpress: string | null
  phpSupported: boolean | null
  unread: string[]
}

export const AGENT = 'CaliperForge-site-snapshot/0.1 (+https://caliperforge.com)'
export const WORDPRESS = 'https://api.wordpress.org/core/version-check/1.7/'
export const PHP = 'https://www.php.net/releases/active.php'

const HOPS = 5
const Offers = z.object({ offers: z.tuple([z.object({ current: z.string() })], z.unknown()) })
const Active = z.record(z.string(), z.record(z.string(), z.unknown()))

export function read(html: string, headers: Headers): Read {
  const server = headers.get('server')
  return {
    generator: generatorOf(html),
    plugins: slugs(html, 'plugins'),
    themes: slugs(html, 'themes'),
    php: /PHP\/([\d.]+)/i.exec(headers.get('x-powered-by') ?? '')?.[1] ?? null,
    server,
    headers: { hsts: headers.has('strict-transport-security'), csp: headers.has('content-security-policy'), frameOptions: headers.has('x-frame-options') },
    cloudflare: headers.has('cf-ray') || server?.toLowerCase() === 'cloudflare',
  }
}

export async function snapshot(url: string, net: Net): Promise<Snapshot> {
  const page = await follow(url, net, HOPS)
  const host = new URL(page.url).hostname
  const unread: string[] = []
  const missed = (what: string) => (e: unknown): null => {
    unread.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  const [tls, nameservers, latestWordpress, active] = await Promise.all([
    net.tls(host).catch(missed('tls')),
    net.ns(host.replace(/^www\./, '')).catch(missed('ns')),
    get(net, WORDPRESS).then(async (r) => Offers.parse(await r.json()).offers[0].current).catch(missed(WORDPRESS)),
    get(net, PHP).then(async (r) => Active.parse(await r.json())).catch(missed(PHP)),
  ])
  const seen = read(page.html, page.headers)
  return {
    url, final: page.url, status: page.status, ...seen, tls, nameservers,
    cloudflareDns: nameservers === null ? null : nameservers.some((n) => n.toLowerCase().endsWith('.ns.cloudflare.com')),
    latestWordpress,
    phpSupported: supported(seen.php, active),
    unread,
  }
}

function get(net: Net, url: string): Promise<Response> {
  return net.fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(15_000) })
}

async function follow(url: string, net: Net, hops: number): Promise<{ url: string; status: number; headers: Headers; html: string }> {
  const res = await get(net, url)
  const location = res.headers.get('location')
  if (hops === 0 || location === null || res.status < 300 || res.status > 399) return { url, status: res.status, headers: res.headers, html: await res.text() }
  return follow(new URL(location, url).href, net, hops - 1)
}

function generatorOf(html: string): Named | null {
  const tag = (html.match(/<meta\b[^>]*>/gi) ?? []).find((m) => /\bname\s*=\s*["']generator["']/i.test(m))
  const content = tag === undefined ? undefined : /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim()
  if (content === undefined || content === '') return null
  const [, name, version] = /^(.+?)\s+v?(\d[\w.-]*)$/.exec(content) ?? []
  return name === undefined || version === undefined ? { name: content, version: null } : { name, version }
}

function slugs(html: string, kind: 'plugins' | 'themes'): Named[] {
  const found = new Map<string, string | null>()
  for (const [, slug = '', rest = ''] of html.matchAll(new RegExp(`/wp-content/${kind}/([\\w.-]+)/([^"'\\s)<>]*)`, 'g'))) {
    const version = /(?:[?&]|&amp;|&#038;)ver=([\w.-]+)/.exec(rest)?.[1] ?? null
    if (!found.has(slug) || found.get(slug) === null) found.set(slug, version)
  }
  return [...found].map(([name, version]) => ({ name, version }))
}

function supported(php: string | null, branches: z.infer<typeof Active> | null): boolean | null {
  const [major, minor] = php?.split('.') ?? []
  if (branches === null || major === undefined || minor === undefined) return null
  return `${major}.${minor}` in (branches[major] ?? {})
}
