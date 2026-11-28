import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findAttestationPda, findCredentialPda, findSchemaPda } from '@solana/attestation'
import { address, createClient, generateKeyPairSigner, lamports, type Address } from '@solana/kit'
import { solanaLocalRpc } from '@solana/kit-plugin-rpc'
import { payer } from '@solana/kit-plugin-signer'
import { expect, test } from 'vitest'
import type { EndpointVerdict, Probe as Probed } from '../assess.ts'
import { SCHEMA, verdictNonce, type Fields } from '../attest.ts'
import { attested, chain, counts, type Chain, type Probe } from '../attested.ts'
import type { ListingScan } from '../card.ts'
import type { Offer } from '../offers.ts'

const ISSUER = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')
const SENT = address('11111111111111111111111111111111')
const PAY_TO = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const OTHER = 'DzSpKpST2TSyrxokMXchFz3G2yn5WEGoxzpGEUDjCX4g'
const CREDENTIAL = 'caliperforge-test'
const TESTED = new Date('2026-11-20T12:34:56.789Z')

const endpoint = (path: string, verdict: EndpointVerdict['verdict'] = 'ok', protocols = ['x402']): ListingScan['endpoints'][number] =>
  ({ verdict, issues: [], protocols, quotedUsd: 0.01, declaredUsd: null, coins: ['USDC'], method: 'GET', path })
const listing = (fqn: string, endpoints: ListingScan['endpoints']): ListingScan => ({ pr: 1, fqn, title: fqn, serviceUrl: 'https://api.acme.test/',
  host: 'api.acme.test', dns: true, freehost: null, flagwords: [], nOps: endpoints.length, nScanned: endpoints.length, endpoints })
const offer = (payTo: string): Offer => ({ proto: 'x402', scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', coin: 'USDC',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usd: 0.01, payTo })
const offered = (resourceUrl: string, ...payTo: string[]): Probed =>
  ({ status: 402, bodyIsJson: true, offers: { offers: payTo.map(offer), x402Source: 'body', x402Version: 2, resourceUrl } })
const stub = (answers: Record<string, Probed>): Probe => (url) => Promise.resolve(answers[url] ?? { error: 'refused' })

const ACME = listing('acme/api', [endpoint('/a/{id}'), endpoint('/a2'), endpoint('/b', 'ok', ['x402', 'mpp'])])
const ONE = listing('acme/one', [endpoint('/b', 'ok', ['x402', 'mpp'])])
const PROBES = stub({
  'https://api.acme.test/a/test': offered('https://a.acme.test/x', PAY_TO),
  'https://api.acme.test/a2': offered('https://a.acme.test/y', PAY_TO),
  'https://api.acme.test/b': offered('https://B.acme.test/z', PAY_TO),
})

async function pdas(issuer: Address, payee: string, host: string): Promise<{ cred: Address; at: Address }> {
  const cred = (await findCredentialPda({ authority: issuer, name: CREDENTIAL }))[0]
  const sch = (await findSchemaPda({ credential: cred, name: SCHEMA.name, version: SCHEMA.version }))[0]
  return { cred, at: (await findAttestationPda({ credential: cred, schema: sch, nonce: verdictNonce(payee, host) }))[0] }
}

function recorder(exists: (at: Address) => boolean = () => false, on = false, fails: (args: unknown[]) => boolean = () => false) {
  const calls: { op: string; args: unknown[] }[] = []
  const asked: Address[] = []
  const op = (name: string) => (...args: unknown[]) => {
    calls.push({ op: name, args })
    return fails(args) ? Promise.reject(new Error('timeout')) : Promise.resolve(SENT)
  }
  const stubbed: Chain = {
    ops: { credential: op('credential'), schema: op('schema'), attest: op('attest'), renew: op('renew'), close: op('close') },
    exists: (at) => Promise.resolve(exists(at)),
    attested: (at) => { asked.push(at); return Promise.resolve(on) },
  }
  return { calls, asked, chain: stubbed }
}

async function run(rows: ListingScan[], c: Chain, dryRun = false): Promise<{ lines: string[]; out: string }> {
  const out = mkdtempSync(join(tmpdir(), 'paydesk-attested-'))
  return { lines: await attested(rows, TESTED, { issuer: ISSUER, credential: CREDENTIAL, out, dryRun }, PROBES, c), out }
}

test('attests each resource host with its own checks', async () => {
  const { calls, asked, chain: c } = recorder()
  const { lines } = await run([ACME], c)
  expect(calls.filter((r) => r.op === 'attest').map((r) => r.args.slice(2))).toEqual([
    [PAY_TO, expect.objectContaining({ host: 'a.acme.test', level: 2, protocols: 1, checks_passed: 2, checks_total: 2 })],
    [PAY_TO, expect.objectContaining({ host: 'b.acme.test', level: 2, protocols: 3, checks_passed: 1, checks_total: 1 })],
  ])
  expect(asked).toStrictEqual([(await pdas(ISSUER, PAY_TO, 'a.acme.test')).at, (await pdas(ISSUER, PAY_TO, 'b.acme.test')).at])
  expect(lines).toStrictEqual([`acme/api a.acme.test ${PAY_TO} attested ${SENT}`, `acme/api b.acme.test ${PAY_TO} attested ${SENT}`])
})

test('a failed send fails its host and the next host is attested', async () => {
  const { calls, chain: c } = recorder(() => true, false, (args) => (args[3] as Fields).host === 'a.acme.test')
  const { lines } = await run([ACME], c)
  expect(calls.map((r) => r.op)).toStrictEqual(['attest', 'attest'])
  expect(lines).toStrictEqual([`acme/api a.acme.test ${PAY_TO} failed: timeout`, `acme/api b.acme.test ${PAY_TO} attested ${SENT}`])
})

test('counts reads attested, renewed, skipped and failed lines', () => {
  expect(counts([`acme/a a.test ${PAY_TO} attested ${SENT}`, `acme/a b.test ${PAY_TO} renewed ${SENT}`, `acme/b c.test ${PAY_TO} renewed ${SENT}`,
    'acme/c d.test - skipped no payee', `acme/d e.test ${PAY_TO} failed: timeout`, `acme/e f.test ${PAY_TO} would attest ${SENT}`]))
    .toStrictEqual({ attested: 1, renewed: 2, skipped: 1, failed: 1 })
})

test('a listing short of pass gets no call and no line', async () => {
  const { calls, chain: c } = recorder()
  const { lines } = await run([listing('acme/warn', [endpoint('/a/{id}', 'warn')])], c)
  expect([lines, calls]).toStrictEqual([[], []])
})

test('a host with two payees or none is skipped', async () => {
  const { calls, chain: c } = recorder()
  const out = mkdtempSync(join(tmpdir(), 'paydesk-attested-'))
  const two = stub({ 'https://api.acme.test/a2': offered('https://a.acme.test/y', PAY_TO, OTHER) })
  const rows = [listing('acme/two', [endpoint('/a2')]), listing('acme/none', [endpoint('/gone')])]
  expect(await attested(rows, TESTED, { issuer: ISSUER, credential: CREDENTIAL, out, dryRun: false }, two, c))
    .toStrictEqual(['acme/two a.acme.test - skipped payees differ', 'acme/none api.acme.test - skipped no payee'])
  expect(calls).toStrictEqual([])
})

test('dry run sends nothing and names the address', async () => {
  const { calls, chain: c } = recorder()
  const { lines, out } = await run([ONE], c, true)
  expect(calls).toStrictEqual([])
  expect(lines).toStrictEqual([`acme/one b.acme.test ${PAY_TO} would attest ${(await pdas(ISSUER, PAY_TO, 'b.acme.test')).at}`])
  expect(existsSync(join(out, 'acme/one/b.acme.test.json'))).toBe(true)
})

test('an attested address is renewed in place', async () => {
  const { calls, chain: c } = recorder(() => true, true)
  const { lines } = await run([ONE], c)
  expect(calls.map(({ op, args }) => [op, args[4]])).toStrictEqual([['renew', (await pdas(ISSUER, PAY_TO, 'b.acme.test')).at]])
  expect(lines).toStrictEqual([`acme/one b.acme.test ${PAY_TO} renewed ${SENT}`])
})

test('the evidence file is the report its fields hash and date', async () => {
  const { calls, chain: c } = recorder(() => true)
  const { out } = await run([ONE], c)
  const path = join(out, 'acme/one/b.acme.test.json')
  const bytes = readFileSync(path)
  expect(calls[0]?.args[3]).toMatchObject<Partial<Fields>>({
    report_uri: path, report_sha256: [...createHash('sha256').update(bytes).digest()], tested_at: 1_795_178_096n,
  })
  expect(JSON.parse(bytes.toString('utf8'))).toStrictEqual({ listing: 'acme/one', host: 'b.acme.test', payee: PAY_TO, tested_at: '2026-11-20T12:34:56.789Z',
    endpoints: [{ method: 'GET', path: '/b', verdict: 'ok', protocols: ['x402', 'mpp'], issues: [], resourceUrl: 'https://B.acme.test/z' }] })
})

test('credential and schema are made only when missing', async () => {
  const { cred } = await pdas(ISSUER, PAY_TO, 'a.acme.test')
  const missing = recorder()
  await run([ACME], missing.chain)
  expect(missing.calls.map((r) => r.op)).toStrictEqual(['credential', 'schema', 'attest', 'attest'])
  const unschemed = recorder((at) => at === cred)
  await run([ACME], unschemed.chain)
  expect(unschemed.calls.map((r) => r.op)).toStrictEqual(['schema', 'attest', 'attest'])
})

const healthy = (): Promise<boolean> => fetch('http://127.0.0.1:8899', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }) })
  .then((r) => r.json()).then((b) => (b as { result?: unknown }).result === 'ok', () => false)

test('surfpool attests a host then renews the same address', { timeout: 120_000 }, async ({ skip }) => {
  if (!(await healthy())) skip('no surfpool on 127.0.0.1:8899')
  const issuer = await generateKeyPairSigner()
  const signer = await generateKeyPairSigner()
  const client = createClient().use(payer(issuer)).use(solanaLocalRpc())
  await client.airdrop(issuer.address, lamports(1_000_000_000n))
  const out = mkdtempSync(join(tmpdir(), 'paydesk-attested-'))
  const once = () => attested([ONE], new Date(), { issuer: issuer.address, credential: CREDENTIAL, out, dryRun: false }, PROBES, chain(client, issuer, signer))
  const { at } = await pdas(issuer.address, PAY_TO, 'b.acme.test')
  expect(await once()).toStrictEqual([`acme/one b.acme.test ${PAY_TO} attested ${at}`])
  expect(await once()).toStrictEqual([`acme/one b.acme.test ${PAY_TO} renewed ${at}`])
})
