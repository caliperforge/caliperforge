import {
  fetchCredential, fetchMaybeAttestation, fetchSchema, findAttestationPda, findCredentialPda, findSchemaPda, type Attestation, type Credential, type Schema,
} from '@solana/attestation'
import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit'
import { usable } from './assess.ts'
import { SCHEMA, verdict, verdictNonce, type Fields } from './attest.ts'
import type { Probe } from './attested.ts'

export interface Reads { attestation(at: Address): Promise<Attestation | null>; credential(at: Address): Promise<Credential>; schema(at: Address): Promise<Schema> }
type Verified = { host: string } & ({ verified: true; data: Fields; payee: string; attestation: Address }
  | { verified: false; reason: string; payee: string | null; attestation: Address | null })

export const reads = (rpc: Rpc<GetAccountInfoApi>): Reads => ({
  attestation: async (at) => {
    const found = await fetchMaybeAttestation(rpc, at)
    return found.exists ? found.data : null
  },
  credential: async (at) => (await fetchCredential(rpc, at)).data,
  schema: async (at) => (await fetchSchema(rpc, at)).data,
})

export async function verified(url: string, method: string, { issuer, credential }: { issuer: Address; credential: string }, probe: Probe, chain: Reads,
  now: () => Promise<bigint>): Promise<Verified> {
  const p = await probe(url, method)
  const host = (URL.parse(('error' in p ? null : p.offers.resourceUrl) ?? '')?.hostname ?? new URL(url).hostname).toLowerCase()
  const refused = (reason: string): Verified => ({ host, payee: null, attestation: null, verified: false, reason })
  if ('error' in p || p.status !== 402) return refused('no 402')
  const payees = [...new Set(usable(p.offers.offers).flatMap((o) => (o.payTo === null ? [] : [o.payTo])))]
  const [payee] = payees
  if (payee === undefined) return refused('no payee')
  if (payees.length > 1) return refused('payees differ')
  const cred = (await findCredentialPda({ authority: issuer, name: credential }))[0]
  const sch = (await findSchemaPda({ credential: cred, name: SCHEMA.name, version: SCHEMA.version }))[0]
  const attestation = (await findAttestationPda({ credential: cred, schema: sch, nonce: verdictNonce(payee, host) }))[0]
  const read = { attestation: await chain.attestation(attestation), credential: await chain.credential(cred), schema: await chain.schema(sch), now: await now() }
  return { host, payee, attestation, ...verdict(read) }
}

export const line = (r: Verified): string => r.verified
  ? `verified ${r.data.listing} ${r.host} ${r.payee} level ${String(r.data.level)} tested ${new Date(Number(r.data.tested_at) * 1000).toISOString()} ${r.attestation}`
  : `unverified ${r.host} ${r.payee ?? '-'} ${r.reason} ${r.attestation ?? '-'}`
