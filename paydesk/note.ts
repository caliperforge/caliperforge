import type { ListingScan } from './card.ts'

const MAX = 5
const SAID: [RegExp, string][] = [
  [/^recipient has no (\S+) token account$/, 'the payTo named in the 402 has no $1 token account, so a payment cannot land; creating the associated token account for that address fixes it for every buyer.'],
  [/^payTo is a token account, not a wallet$/, 'the 402 names a token account as payTo; it should name the owner wallet.'],
  [/^price listed \$(\S+) vs asked \$(\S+)$/, 'the 402 asks $$$2 but the listing declares $$$1; one of them is wrong.'],
]

export function note(scan: ListingScan, from: string): string | null {
  const base = scan.serviceUrl.replace(/\/+$/, '')
  const lines = scan.endpoints.flatMap((e) => {
    const said = sentences(e)
    return said.length === 0 ? [] : [`${e.method} \`${base}${e.path}\`: ${said.join(' ')}`]
  })
  if (lines.length === 0) return null
  const kept = lines.length > MAX ? [...lines.slice(0, MAX - 1), `${String(lines.length - MAX + 1)} more endpoints have issues like these.`] : lines
  return `${['Hi,', ...kept, "Happy to re-test once it's done.", from].join('\n')}\n`
}

function sentences({ verdict, issues }: ListingScan['endpoints'][number]): string[] {
  if (verdict === 'no_402' || verdict === 'unreachable') return issues.slice(0, 1).map((i) => `it answered ${i} instead of a 402 on an unpaid call.`)
  return issues.flatMap((i) => {
    const hit = SAID.find(([re]) => re.test(i))
    return hit === undefined ? [] : [i.replace(hit[0], hit[1])]
  })
}
