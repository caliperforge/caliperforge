import { fetchCredential, fetchMaybeAttestation, fetchSchema, serializeAttestationData, type Attestation, type Credential, type Schema } from '@solana/attestation'
import { address, createClient, generateKeyPairSigner, lamports, type Address } from '@solana/kit'
import { solanaLocalRpc } from '@solana/kit-plugin-rpc'
import { payer } from '@solana/kit-plugin-signer'
import { fetchSysvarClock } from '@solana/sysvars'
import { expect, test } from 'vitest'
import { attestOps, SCHEMA, settled, verdict, verdictNonce, type Fields } from '../attest.ts'

const URL = 'http://127.0.0.1:8899'
const ISSUER = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')
const SIGNER = address('DzSpKpST2TSyrxokMXchFz3G2yn5WEGoxzpGEUDjCX4g')
const PAY_TO = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

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

test('verdictNonce is fixed per payee and lowercased host', () => {
  expect(verdictNonce(PAY_TO, 'example.com')).toBe('7NRdn8ENyYj9b6Ysq4SNt3gQHTswrSaoegspgd9TBxSu')
  expect(verdictNonce(PAY_TO, 'Example.COM')).toBe(verdictNonce(PAY_TO, 'example.com'))
  expect(verdictNonce(PAY_TO, 'other.example')).toBe('BWDBGC6DVYDmchm4GNKQ3X6jdSZpvtRE8eDAh9AYvFzZ')
})

test('verdict refuses each failed check with its reason', () => {
  const read = (over: Partial<Parameters<typeof verdict>[0]>) => verdict({ attestation, credential, schema, now: 1_000n, ...over })
  expect(read({ attestation: null })).toEqual({ verified: false, reason: 'no attestation' })
  expect(read({ credential: { ...credential, authorizedSigners: [ISSUER] } })).toEqual({ verified: false, reason: 'signer no longer authorized' })
  expect(read({ now: 2_000n })).toEqual({ verified: false, reason: 'expired' })
  expect(read({ schema: { ...schema, isPaused: true } })).toEqual({ verified: false, reason: 'schema paused' })
  expect(read({ attestation: { ...attestation, expiry: 0n }, now: 9_999_999_999n }).verified).toBe(true)
})

test('verdict passes and decodes all eleven fields', () => {
  expect(verdict({ attestation, credential, schema, now: 1_000n })).toEqual({ verified: true, data: FIELDS })
})

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
const sender = (...answers: (() => Promise<unknown>)[]) => {
  const sent = { count: 0 }
  return { sent, send: () => (answers[sent.count++] ?? (() => Promise.reject(new Error('unexpected send'))))() }
}
const hang = (): Promise<never> => new Promise(() => undefined)

test('settled times out twice and leaves no timer behind', async () => {
  const before = timers()
  const { sent, send } = sender(hang, hang)
  await expect(settled(send, () => Promise.resolve(false), 10)).rejects.toThrow('timeout')
  expect([sent.count, timers()]).toStrictEqual([2, before])
})

test('settled does not send again once the first send landed', async () => {
  const { sent, send } = sender(hang, () => Promise.resolve())
  await settled(send, () => Promise.resolve(true), 10)
  expect(sent.count).toBe(1)
})

test('settled sends again after a rejection that did not land', async () => {
  const { sent, send } = sender(() => Promise.reject(new Error('blockhash expired')), () => Promise.resolve())
  await settled(send, () => Promise.resolve(false), 10)
  expect(sent.count).toBe(2)
})

const healthy = (): Promise<boolean> => fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }) })
  .then((r) => r.json()).then((b) => (b as { result?: unknown }).result === 'ok', () => false)

test('surfpool attests, renews in place and closes a verdict', { timeout: 120_000 }, async ({ skip }) => {
  if (!(await healthy())) skip('no surfpool on 127.0.0.1:8899')
  const issuer = await generateKeyPairSigner()
  const signer = await generateKeyPairSigner()
  const client = createClient().use(payer(issuer)).use(solanaLocalRpc())
  await client.airdrop(issuer.address, lamports(1_000_000_000n))
  const ops = attestOps(client, issuer, signer)
  const cred = await ops.credential('caliperforge-smoke')
  const sch = await ops.schema(cred)
  const now = (await fetchSysvarClock(client.rpc)).unixTimestamp
  const read = async (at: Address) => {
    const found = await fetchMaybeAttestation(client.rpc, at)
    return verdict({ attestation: found.exists ? found.data : null, credential: (await fetchCredential(client.rpc, cred)).data,
      schema: (await fetchSchema(client.rpc, sch)).data, now })
  }
  const first = await ops.attest(cred, sch, PAY_TO, { ...FIELDS, tested_at: now })
  expect(await read(first)).toEqual({ verified: true, data: { ...FIELDS, tested_at: now } })
  const renewed = await ops.renew(cred, sch, PAY_TO, { ...FIELDS, tested_at: now + 1n }, first)
  expect(renewed).toBe(first)
  expect(await read(renewed)).toEqual({ verified: true, data: { ...FIELDS, tested_at: now + 1n } })
  await ops.close(cred, renewed)
  expect(await read(renewed)).toEqual({ verified: false, reason: 'no attestation' })
})
