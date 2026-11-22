import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  findAttestationPda, findCredentialPda, findSchemaPda, getChangeAuthorizedSignersInstruction, serializeAttestationData, type Attestation, type Credential, type Schema,
} from '@solana/attestation'
import { address, createClient, generateKeyPairSigner, lamports, type Address } from '@solana/kit'
import { solanaLocalRpc } from '@solana/kit-plugin-rpc'
import { payer } from '@solana/kit-plugin-signer'
import { fetchSysvarClock } from '@solana/sysvars'
import { expect, test } from 'vitest'
import type { Probe as Probed } from '../assess.ts'
import { attestOps, SCHEMA, verdictNonce, type Fields } from '../attest.ts'
import { probe, type Probe } from '../attested.ts'
import type { Offer } from '../offers.ts'
import { line, reads, verified, type Reads } from '../verify.ts'

const ISSUER = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')
const SIGNER = address('DzSpKpST2TSyrxokMXchFz3G2yn5WEGoxzpGEUDjCX4g')
const PAY_TO = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const CREDENTIAL = 'caliperforge-test'
const PROBED = 'https://api.example.com/r'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const FIELDS: Fields = {
  listing: 'x402/example', host: 'example.com', level: 3, protocols: 2, price_ok: true, delivers: false,
  checks_passed: 41, checks_total: 44, tested_at: 1_795_000_000n, report_uri: 'https://example.com/r/1', report_sha256: [...Array(32).keys()],
}

const schema: Schema = { discriminator: 1, credential: ISSUER, isPaused: false, ...SCHEMA }
const credential: Credential = { discriminator: 0, authority: ISSUER, name: new Uint8Array(), authorizedSigners: [SIGNER] }
const attestation: Attestation = {
  discriminator: 2, nonce: verdictNonce(PAY_TO, FIELDS.host), credential: ISSUER, schema: ISSUER,
  data: serializeAttestationData(schema, { ...FIELDS }), signer: SIGNER, expiry: 2_000n, tokenAccount: ISSUER,
}

const offer = (payTo: string | null, network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'): Offer =>
  ({ proto: 'x402', scheme: 'exact', network, coin: 'USDC', asset: USDC, usd: 0.01, payTo })
const answered = (offers: Offer[], resourceUrl: string | null = 'https://example.com/r', status = 402): Probed =>
  ({ status, bodyIsJson: true, offers: { offers, x402Source: 'body', x402Version: 2, resourceUrl } })
const stub = (p: Probed): Probe => () => Promise.resolve(p)
const chainOf = ({ attestation: a = attestation, credential: c = credential, schema: s = schema }:
  { attestation?: Attestation | null; credential?: Credential; schema?: Schema } = {}): Reads =>
  ({ attestation: () => Promise.resolve(a), credential: () => Promise.resolve(c), schema: () => Promise.resolve(s) })
const run = (p: Probed, chain = chainOf(), now = 1_000n) =>
  verified(PROBED, 'GET', { issuer: ISSUER, credential: CREDENTIAL }, stub(p), chain, () => Promise.resolve(now))

async function at(host: string): Promise<Address> {
  const cred = (await findCredentialPda({ authority: ISSUER, name: CREDENTIAL }))[0]
  const sch = (await findSchemaPda({ credential: cred, name: SCHEMA.name, version: SCHEMA.version }))[0]
  return (await findAttestationPda({ credential: cred, schema: sch, nonce: verdictNonce(PAY_TO, host) }))[0]
}

test('a live attestation by an authorized signer reads verified', async () => {
  const result = await run(answered([offer(PAY_TO)]))
  expect(result).toEqual({ host: 'example.com', payee: PAY_TO, attestation: await at('example.com'), verified: true, data: FIELDS })
  expect(line(result)).toBe(`verified x402/example example.com ${PAY_TO} level 3 tested 2026-11-18T11:06:40.000Z ${await at('example.com')}`)
})

test('each failed check reads unverified at the derived address', async () => {
  const paid = answered([offer(PAY_TO)])
  const refused = { host: 'example.com', payee: PAY_TO, attestation: await at('example.com'), verified: false }
  expect(await run(paid, chainOf({ attestation: null }))).toStrictEqual({ ...refused, reason: 'no attestation' })
  expect(await run(paid, chainOf({ credential: { ...credential, authorizedSigners: [ISSUER] } })))
    .toStrictEqual({ ...refused, reason: 'signer no longer authorized' })
  expect(await run(paid, chainOf(), 2_000n)).toStrictEqual({ ...refused, reason: 'expired' })
  expect(await run(paid, chainOf({ schema: { ...schema, isPaused: true } }))).toStrictEqual({ ...refused, reason: 'schema paused' })
  expect(line(await run(paid, chainOf(), 2_000n))).toBe(`unverified example.com ${PAY_TO} expired ${await at('example.com')}`)
})

test('no 402, no payee and two payees name no payee or address', async () => {
  const refused = (host: string, reason: string) => ({ host, payee: null, attestation: null, verified: false, reason })
  expect(await run({ error: 'refused' })).toStrictEqual(refused('api.example.com', 'no 402'))
  expect(await run(answered([offer(PAY_TO)], null, 200))).toStrictEqual(refused('api.example.com', 'no 402'))
  expect(await run(answered([offer(PAY_TO, 'eip155:8453'), offer(null)]))).toStrictEqual(refused('example.com', 'no payee'))
  expect(await run(answered([offer(PAY_TO), offer(SIGNER)]))).toStrictEqual(refused('example.com', 'payees differ'))
  expect(line(await run({ error: 'refused' }))).toBe('unverified api.example.com - no 402 -')
})

test('an upper-case resource host derives the lower-case address', async () => {
  const upper = await run(answered([offer(PAY_TO)], 'https://EXAMPLE.com/r'))
  expect([upper.host, upper.attestation]).toStrictEqual(['example.com', await at('example.com')])
})

const healthy = (): Promise<boolean> => fetch('http://127.0.0.1:8899', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }) })
  .then((r) => r.json()).then((b) => (b as { result?: unknown }).result === 'ok', () => false)

test('surfpool reads attest, signer removal and close back', { timeout: 120_000 }, async ({ skip }) => {
  if (!(await healthy())) skip('no surfpool on 127.0.0.1:8899')
  const body = JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'solana', amount: '10000', asset: USDC, payTo: PAY_TO }] })
  const server = createServer((req, res) => { res.writeHead(req.url === '/r' ? 402 : 404, { 'Content-Type': 'application/json' }).end(body) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/r`
    const issuer = await generateKeyPairSigner()
    const signer = await generateKeyPairSigner()
    const client = createClient().use(payer(issuer)).use(solanaLocalRpc())
    await client.airdrop(issuer.address, lamports(1_000_000_000n))
    const ops = attestOps(client, issuer, signer)
    const cred = await ops.credential(CREDENTIAL)
    const sch = await ops.schema(cred)
    const now = async () => (await fetchSysvarClock(client.rpc)).unixTimestamp
    const written = await ops.attest(cred, sch, PAY_TO, { ...FIELDS, host: '127.0.0.1', tested_at: await now() })
    const read = async () => {
      const r = await verified(url, 'GET', { issuer: issuer.address, credential: CREDENTIAL }, probe({ fetch, resolve: () => Promise.resolve() }), reads(client.rpc), now)
      return [r.attestation, r.verified ? 'verified' : r.reason]
    }
    expect(await read()).toStrictEqual([written, 'verified'])
    await client.sendTransaction([getChangeAuthorizedSignersInstruction({ payer: issuer, authority: issuer, credential: cred, signers: [issuer.address] })])
    expect(await read()).toStrictEqual([written, 'signer no longer authorized'])
    await attestOps(client, issuer, issuer).close(cred, written)
    expect(await read()).toStrictEqual([written, 'no attestation'])
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
