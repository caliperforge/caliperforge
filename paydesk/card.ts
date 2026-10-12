import type { EndpointVerdict } from './assess.ts'

export interface ListingScan { pr: number; fqn: string; title: string; serviceUrl: string; host: string; dns: boolean; freehost: string | null; flagwords: string[]; nOps: number; nScanned: number; endpoints: (EndpointVerdict & { method: string; path: string })[] }

const FREEHOST = ['railway.app', 'onrender.com', 'vercel.app', 'workers.dev', 'fly.dev', 'ts.net', 'duckdns.org', 'nip.io', 'run.app', 'netlify.app', 'herokuapp.com', 'ngrok']
const FLAGWORDS = ['memecoin', 'meme coin', 'pump.fun', 'pumpfun', 'rug', 'sniper', 'snipe', 'sniping', 'KOL', 'degen', 'bonding curve', 'honeypot', 'ape']
const UNREADABLE = '402 without a readable offer'

export function listingFlags(host: string, text: string): { freehost: string | null; flagwords: string[] } {
  const h = host.toLowerCase()
  const hosted = (f: string): boolean => (f === 'ngrok' ? h.includes(f) : h === f || h.endsWith(`.${f}`))
  const said = (w: string): boolean => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
  return { freehost: FREEHOST.find(hosted) ?? null, flagwords: FLAGWORDS.filter(said) }
}

export function card(scan: ListingScan): string {
  const usd = (n: number | null): string => (n === null ? '-' : `$${String(n)}`)
  const rows = scan.endpoints.map((e) =>
    `| ${e.method} | ${e.path.length > 80 ? `${e.path.slice(0, 80)}…` : e.path} | ${e.verdict} | ${e.protocols.join(', ')} | ${usd(e.quotedUsd)} | ${usd(e.declaredUsd)} | ${e.issues.join('; ')} |`)
  return [
    `## ${scan.fqn}: ${scan.title} (#${String(scan.pr)})`,
    '',
    `**${overall(scan)}**`,
    ...(scan.dns ? [] : [`- DNS does not resolve: ${scan.host}`]),
    ...(scan.freehost === null ? [] : [`- free hosting: ${scan.freehost}`]),
    ...(scan.flagwords.length === 0 ? [] : [`- flag words: ${scan.flagwords.join(', ')}`]),
    '',
    '| method | path | verdict | protocols | asked | listed | issues |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

export function overall({ dns, endpoints }: ListingScan): string {
  const readable = endpoints.some((e) => e.verdict === 'ok' || e.verdict === 'warn' || (e.verdict === 'fail' && !(e.issues.length === 1 && e.issues[0] === UNREADABLE)))
  if (!dns || !readable) return 'reject'
  return endpoints.every((e) => e.verdict === 'ok') ? 'pass' : 'fix needed'
}
