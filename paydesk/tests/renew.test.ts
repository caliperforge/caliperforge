import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchMaybeAttestation, findAttestationPda, findCredentialPda, findSchemaPda } from '@solana/attestation'
import { address, createClient, generateKeyPairSigner, lamports, type Address } from '@solana/kit'
import { solanaLocalRpc } from '@solana/kit-plugin-rpc'
import { payer } from '@solana/kit-plugin-signer'
import { expect, test } from 'vitest'
import type { EndpointVerdict, Probe as Probed } from '../assess.ts'
import { SCHEMA, verdictNonce } from '../attest.ts'
import { chain, type Chain, type Probe } from '../attested.ts'
import type { ListingScan } from '../card.ts'
import type { Offer } from '../offers.ts'
import { renew } from '../renew.ts'

const ISSUER = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')
const SENT = address('11111111111111111111111111111111')
const PAY_TO = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const CREDENTIAL = 'caliperforge-test'
const DATE = '2026-11-23'

const endpoint = (path: string, verdict: EndpointVerdict['verdict'] = 'ok'): ListingScan['endpoints'][number] =>
  ({ verdict, issues: [], protocols: ['x402'], quotedUsd: 0.01, declaredUsd: null, coins: ['USDC'], method: 'GET', path })
const listing = (fqn: string, endpoints: ListingScan['endpoints']): ListingScan => ({ pr: 1, fqn, title: fqn, serviceUrl: 'https://api.acme.test/',
  host: 'api.acme.test', dns: true, freehost: null, flagwords: [], nOps: endpoints.length, nScanned: endpoints.length, endpoints })
const offer = (payTo: string): Offer => ({ proto: 'x402', scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', coin: 'USDC',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usd: 0.01, payTo })
const offered = (resourceUrl: string, ...payTo: string[]): Probed =>
  ({ status: 402, bodyIsJson: true, offers: { offers: payTo.map(offer), x402Source: 'body', x402Version: 2, resourceUrl } })
const stub = (answers: Record<string, Probed>): Probe => (url) => Promise.resolve(answers[url] ?? { error: 'refused' })

const PROBES = stub({
  'https://api.acme.test/a': offered('https://a.acme.test/x', PAY_TO),
  'https://api.acme.test/b': offered('https://b.acme.test/z', PAY_TO),
})

async function pdas(issuer: Address, host: string): Promise<{ cred: Address; at: Address }> {
  const cred = (await findCredentialPda({ authority: issuer, name: CREDENTIAL }))[0]
  const sch = (await findSchemaPda({ credential: cred, name: SCHEMA.name, version: SCHEMA.version }))[0]
  return { cred, at: (await findAttestationPda({ credential: cred, schema: sch, nonce: verdictNonce(PAY_TO, host) }))[0] }
}

function recorder() {
  const calls: { op: string; args: unknown[] }[] = []
  const op = (name: string) => (...args: unknown[]) => { calls.push({ op: name, args }); return Promise.resolve(SENT) }
  const stubbed: Chain = {
    ops: { credential: op('credential'), schema: op('schema'), attest: op('attest'), renew: op('renew'), close: op('close') },
    exists: () => Promise.resolve(true),
    attested: () => Promise.resolve(true),
  }
  return { calls, connect: () => Promise.resolve({ issuer: ISSUER, chain: stubbed }) }
}

function world(rows: ListingScan[], hosts: [string, string][], date = DATE): string {
  const root = mkdtempSync(join(tmpdir(), 'paydesk-renew-'))
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put('.cf/attest/config.json', JSON.stringify({ rpc: 'http://127.0.0.1:8899', credential: CREDENTIAL, issuer: 'issuer.json', signer: 'signer.json' }))
  for (const [fqn, host] of hosts) put(`.cf/attest/evidence/${fqn}/${host}.json`, JSON.stringify({ listing: fqn, host, payee: PAY_TO }))
  put(`.cf/paydesk/live-${date}.jsonl`, rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  return root
}

const evidence = (root: string, fqn: string, host: string): string => join(root, '.cf/attest/evidence', fqn, `${host}.json`)
const closed = (root: string, fqn: string, host: string): string => join(root, '.cf/attest/closed', DATE, fqn, `${host}.json`)

test('a listing still passing is renewed and its evidence stays', async () => {
  const root = world([listing('acme/one', [endpoint('/b')])], [['acme/one', 'b.acme.test']])
  const { calls, connect } = recorder()
  expect(await renew(root, DATE, connect, PROBES)).toStrictEqual({ attested: 0, renewed: 1, closed: 0, skipped: 0 })
  expect(calls.map((c) => c.op)).toStrictEqual(['renew'])
  expect(existsSync(evidence(root, 'acme/one', 'b.acme.test'))).toBe(true)
})

test.each([
  { why: 'now failing', rows: [listing('acme/one', [endpoint('/b', 'fail')])] },
  { why: 'gone from the rows', rows: [] },
])('a listing $why is closed and its evidence moved', async ({ rows }) => {
  const root = world(rows, [['acme/one', 'b.acme.test']])
  const { calls, connect } = recorder()
  expect(await renew(root, DATE, connect, PROBES)).toStrictEqual({ attested: 0, renewed: 0, closed: 1, skipped: 0 })
  const { cred, at } = await pdas(ISSUER, 'b.acme.test')
  expect(calls).toStrictEqual([{ op: 'close', args: [cred, at] }])
  expect([existsSync(evidence(root, 'acme/one', 'b.acme.test')), existsSync(closed(root, 'acme/one', 'b.acme.test'))]).toStrictEqual([false, true])
})

test('a host dropped from a passing listing is closed', async () => {
  const root = world([listing('acme/api', [endpoint('/a')])], [['acme/api', 'a.acme.test'], ['acme/api', 'b.acme.test']])
  const { calls, connect } = recorder()
  expect(await renew(root, DATE, connect, PROBES)).toStrictEqual({ attested: 0, renewed: 1, closed: 1, skipped: 0 })
  const { cred, at } = await pdas(ISSUER, 'b.acme.test')
  expect(calls.map((c) => [c.op, c.op === 'close' ? c.args : c.args[3]])).toStrictEqual([
    ['renew', expect.objectContaining({ host: 'a.acme.test' })], ['close', [cred, at]]])
  expect(existsSync(evidence(root, 'acme/api', 'a.acme.test'))).toBe(true)
  expect(existsSync(closed(root, 'acme/api', 'b.acme.test'))).toBe(true)
})

test('a missing config throws before chain or probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'paydesk-renew-'))
  const touched: string[] = []
  const connect = () => { touched.push('chain'); return recorder().connect() }
  const probe: Probe = (url, method) => { touched.push('probe'); return PROBES(url, method) }
  await expect(renew(root, DATE, connect, probe)).rejects.toThrow(`no attest config at ${root}/.cf/attest/config.json`)
  expect(touched).toStrictEqual([])
})

const healthy = (): Promise<boolean> => fetch('http://127.0.0.1:8899', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }) })
  .then((r) => r.json()).then((b) => (b as { result?: unknown }).result === 'ok', () => false)

test('surfpool closes an attestation whose listing fails', { timeout: 120_000 }, async ({ skip }) => {
  if (!(await healthy())) skip('no surfpool on 127.0.0.1:8899')
  const issuer = await generateKeyPairSigner()
  const signer = await generateKeyPairSigner()
  const client = createClient().use(payer(issuer)).use(solanaLocalRpc())
  await client.airdrop(issuer.address, lamports(1_000_000_000n))
  const connect = () => Promise.resolve({ issuer: issuer.address, chain: chain(client, issuer, signer) })
  const root = world([listing('acme/one', [endpoint('/b')])], [], '2026-11-16')
  expect(await renew(root, '2026-11-16', connect, PROBES)).toStrictEqual({ attested: 1, renewed: 0, closed: 0, skipped: 0 })
  writeFileSync(join(root, `.cf/paydesk/live-${DATE}.jsonl`), `${JSON.stringify(listing('acme/one', [endpoint('/b', 'fail')]))}\n`)
  expect(await renew(root, DATE, connect, PROBES)).toStrictEqual({ attested: 0, renewed: 0, closed: 1, skipped: 0 })
  expect((await fetchMaybeAttestation(client.rpc, (await pdas(issuer.address, 'b.acme.test')).at)).exists).toBe(false)
})
