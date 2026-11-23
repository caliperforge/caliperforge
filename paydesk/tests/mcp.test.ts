import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { address } from '@solana/kit'
import { expect, test } from 'vitest'
import type { Fields } from '../attest.ts'
import { server, type Check } from '../mcp.ts'
import type { Config } from '../renew.ts'
import { line, type Verified } from '../verify.ts'

const AT = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')
const PAY_TO = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const FIELDS: Fields = {
  listing: 'x402/example', host: 'example.com', level: 3, protocols: 2, price_ok: true, delivers: false,
  checks_passed: 41, checks_total: 44, tested_at: 1_795_000_000n, report_uri: 'https://example.com/r/1', report_sha256: [...Array(32).keys()],
}
const VERIFIED: Verified = { host: 'example.com', payee: PAY_TO, attestation: AT, verified: true, data: FIELDS }
const UNVERIFIED: Verified = { host: 'api.example.com', payee: null, attestation: null, verified: false, reason: 'no 402' }

async function connected(root: string, check: Check): Promise<Client> {
  const [client, transport] = InMemoryTransport.createLinkedPair()
  await server(root, check).connect(transport)
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(client)
  return c
}

function configured(root = mkdtempSync(join(tmpdir(), 'mcp-'))): string {
  mkdirSync(join(root, '.cf/attest'), { recursive: true })
  writeFileSync(join(root, '.cf/attest/config.json'), JSON.stringify({ rpc: 'http://127.0.0.1:8899', credential: 'c', issuer: 'issuer.json', signer: 's.json' }))
  return root
}

test('lists verify_seller alone, url required and method optional', async () => {
  const { tools } = await (await connected(configured(), () => Promise.reject(new Error('unused')))).listTools()
  expect(tools.map((t) => [t.name, t.inputSchema.required, Object.keys(t.inputSchema.properties ?? {})]))
    .toStrictEqual([['verify_seller', ['url'], ['url', 'method']]])
})

test('a check result returns as structured content and its line', async () => {
  const root = configured()
  const calls: [string, string, Config][] = []
  const client = await connected(root, (url, method, config) => {
    calls.push([url, method, config])
    return Promise.resolve(url === 'https://example.com/r' ? VERIFIED : UNVERIFIED)
  })
  expect(await client.callTool({ name: 'verify_seller', arguments: { url: 'https://example.com/r' } })).toStrictEqual({
    content: [{ type: 'text', text: line(VERIFIED) }],
    structuredContent: { verified: true, listing: 'x402/example', host: 'example.com', payee: PAY_TO, level: 3, tested_at: '2026-11-18T11:06:40.000Z', attestation: AT },
  })
  expect(await client.callTool({ name: 'verify_seller', arguments: { url: 'https://api.example.com/r', method: 'POST' } })).toStrictEqual({
    content: [{ type: 'text', text: line(UNVERIFIED) }],
    structuredContent: { verified: false, reason: 'no 402', host: 'api.example.com' },
  })
  expect(calls.map(([url, method, config]) => [url, method, config.issuer])).toStrictEqual([
    ['https://example.com/r', 'GET', join(root, 'issuer.json')], ['https://api.example.com/r', 'POST', join(root, 'issuer.json')]])
})

test('a missing config is a tool error and a later config answers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-'))
  let called = 0
  const client = await connected(root, () => {
    called++
    return Promise.resolve(UNVERIFIED)
  })
  const call = () => client.callTool({ name: 'verify_seller', arguments: { url: 'https://example.com/r' } })
  expect(await call()).toStrictEqual({ content: [{ type: 'text', text: `no attest config at ${join(root, '.cf/attest/config.json')}` }], isError: true })
  expect(called).toBe(0)
  configured(root)
  expect((await call()).structuredContent).toStrictEqual({ verified: false, reason: 'no 402', host: 'api.example.com' })
  expect(called).toBe(1)
})
