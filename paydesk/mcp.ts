import { lookup } from 'node:dns/promises'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createSolanaRpc } from '@solana/kit'
import { fetchSysvarClock } from '@solana/sysvars'
import { z } from 'zod'
import { probe } from './attested.ts'
import { configOf, keypair, type Config } from './renew.ts'
import type { Net } from './scan.ts'
import { line, reads, verified, type Verified } from './verify.ts'

const NET: Net = { fetch, resolve: (host) => lookup(host) }

export type Check = (url: string, method: string, config: Config) => Promise<Verified>

const checked: Check = async (url, method, config) => {
  const rpc = createSolanaRpc(config.rpc)
  const { address: issuer } = await keypair(config.issuer)
  return verified(url, method, { issuer, credential: config.credential }, probe(NET), reads(rpc), async () => (await fetchSysvarClock(rpc)).unixTimestamp)
}

const OUTPUT = { verified: z.boolean(), reason: z.string().optional(), listing: z.string().optional(), host: z.string(), payee: z.string().optional(),
  level: z.number().optional(), tested_at: z.string().optional(), attestation: z.string().optional() }

const structured = (r: Verified): Record<string, unknown> => r.verified
  ? { verified: true, listing: r.data.listing, host: r.host, payee: r.payee, level: r.data.level,
      tested_at: new Date(Number(r.data.tested_at) * 1000).toISOString(), attestation: r.attestation }
  : { verified: false, reason: r.reason, host: r.host, ...(r.payee === null ? {} : { payee: r.payee }),
      ...(r.attestation === null ? {} : { attestation: r.attestation }) }

export function server(root: string, check: Check = checked): McpServer {
  const mcp = new McpServer({ name: 'paydesk', version: '0.1.0' })
  mcp.registerTool('verify_seller', {
    description: 'Read whether the seller at a paid URL holds a live attestation on chain, before paying it.',
    inputSchema: { url: z.string(), method: z.string().optional() },
    outputSchema: OUTPUT,
  }, async ({ url, method }) => {
    const config = configOf(root)
    const r = await check(url, method ?? 'GET', { ...config, issuer: resolve(root, config.issuer) })
    return { content: [{ type: 'text', text: line(r) }], structuredContent: structured(r) }
  })
  return mcp
}

export async function serve(root: string): Promise<void> {
  await server(root).connect(new StdioServerTransport())
}
