import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Read } from '../cli/gh.ts'

export const OWNED: string[] = z.object({ owned: z.array(z.string()) }).parse(parse(readFileSync(join(import.meta.dirname, '../rules/hardware.yaml'), 'utf8'))).owned

export const EMULATORS = z.object({ emulators: z.array(z.object({ device: z.string(), stand_in: z.string(), limits: z.string() })) })
  .parse(parse(readFileSync(join(import.meta.dirname, '../rules/emulators.yaml'), 'utf8'))).emulators

/** Solana prose says "ledger" for the chain, so brand names match case-sensitive. */
const DEVICES: Record<string, RegExp> = {
  Ledger: /\bLedgers?\b/,
  Trezor: /\bTrezor\b/,
  Keystone: /\bKeystone\b/,
  HID: /\bHID\b/,
  USB: /\bUSB\b/,
  'hardware wallet': /\bhardware wallets?\b/i,
  Bluetooth: /\bBluetooth\b/i,
  phone: /\bphones?\b/i,
}

const Issue = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
  comments: z.array(z.object({ body: z.string(), url: z.string() })),
})

const Found = z.object({ items: z.array(z.object({ path: z.string() })) })

const File = z.object({ content: z.string() })

const TEST_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

export function hardware(repo: string, no: number, read: Read, owned = OWNED, emulators = EMULATORS): { park: string | null; lines: string } {
  const row = Issue.parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'title,body,url,comments']))
  const covered = [...owned]
  let lines = ''
  let named = scan(repo, row, read, covered)
  while (named !== undefined) {
    const { device: found, where } = named
    const stand = emulators.find((e) => e.device === found.toLowerCase())
    if (stand === undefined) return { park: `hardware: ${found} — ${where}`, lines: '' }
    lines += `- hardware: ${stand.device} — ${stand.stand_in}; limits: ${stand.limits} — ${where}\n`
    covered.push(found)
    named = scan(repo, row, read, covered)
  }
  return { park: null, lines }
}

function scan(repo: string, row: z.infer<typeof Issue>, read: Read, covered: string[]): { device: string; where: string } | undefined {
  for (const { body, url } of [{ body: `${row.title}\n${row.body}`, url: row.url }, ...row.comments]) {
    const named = device(body, covered)
    if (named !== undefined) return { device: named, where: url }
  }
  const spans = [row.body, ...row.comments.map((c) => c.body)].join('\n').match(/`[^`\n]+`/g) ?? []
  for (const name of new Set(spans.map((s) => s.slice(1, -1)).filter((s) => TEST_NAME.test(s)))) {
    for (const { path } of Found.parse(read(['api', `search/code?q=${name}+repo:${repo}`])).items) {
      const source = Buffer.from(File.parse(read(['api', `repos/${repo}/contents/${path}`])).content.replace(/\n/g, ''), 'base64')
      const named = gated(source.toString('utf8').split('\n'), name, covered)
      if (named !== undefined) return { device: named, where: `\`${name}\` in ${path}` }
    }
  }
  return undefined
}

function device(text: string, owned: string[]): string | undefined {
  return Object.entries(DEVICES).find(([name, word]) => !owned.includes(name) && word.test(text))?.[0]
}

/** The unowned device an `#[ignore` in the attributes directly above `fn <name>` names. */
function gated(lines: string[], name: string, owned: string[]): string | undefined {
  const at = lines.findIndex((l) => new RegExp(`\\bfn ${name}\\b`).test(l))
  let top = at
  while (top > 0 && /^\s*#\[/.test(lines[top - 1] ?? '')) top -= 1
  const attributes = lines.slice(top, at).join('\n')
  return attributes.includes('#[ignore') ? device(attributes, owned) : undefined
}
