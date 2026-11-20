import { createHash } from 'node:crypto'
import {
  deserializeAttestationData, fetchSchema, findAttestationPda, findCredentialPda, findSchemaPda, getCloseAttestationInstruction,
  getCreateAttestationInstructionAsync, getCreateCredentialInstructionAsync, getCreateSchemaInstructionAsync, SchemaDataType as T,
  serializeAttestationData, type Attestation, type Credential, type Schema,
} from '@solana/attestation'
import {
  getAddressDecoder, type Address, type ClientWithPayer, type ClientWithRpc, type ClientWithTransactionSending, type GetAccountInfoApi,
  type TransactionSigner,
} from '@solana/kit'

export interface Fields {
  listing: string
  host: string
  level: number
  protocols: number
  price_ok: boolean
  delivers: boolean
  checks_passed: number
  checks_total: number
  tested_at: bigint
  report_uri: string
  report_sha256: number[]
}

export const SCHEMA = {
  name: 'pay-conformance',
  version: 1,
  description: 'CaliperForge pay-conformance verdict',
  fieldNames: ['listing', 'host', 'level', 'protocols', 'price_ok', 'delivers', 'checks_passed', 'checks_total', 'tested_at', 'report_uri', 'report_sha256'],
  layout: [T.String, T.String, T.U8, T.U8, T.Bool, T.Bool, T.U16, T.U16, T.I64, T.String, T.VecU8],
}

const DAY = 86_400n

export const verdictNonce = (payTo: string, host: string): Address =>
  getAddressDecoder().decode(createHash('sha256').update(`pay-conformance:v1|${payTo}|${host.toLowerCase()}`).digest())

export function verdict({ attestation, credential, schema, now }: { attestation: Attestation | null; credential: Credential; schema: Schema; now: bigint }):
  { verified: true; data: Fields } | { verified: false; reason: string } {
  if (attestation === null) return { verified: false, reason: 'no attestation' }
  if (!credential.authorizedSigners.includes(attestation.signer)) return { verified: false, reason: 'signer no longer authorized' }
  if (attestation.expiry !== 0n && attestation.expiry <= now) return { verified: false, reason: 'expired' }
  if (schema.isPaused) return { verified: false, reason: 'schema paused' }
  return { verified: true, data: deserializeAttestationData<Fields>(schema, attestation.data) }
}

type Client = ClientWithPayer & ClientWithTransactionSending & ClientWithRpc<GetAccountInfoApi>

export function attestOps(client: Client, issuer: TransactionSigner, signer: TransactionSigner) {
  const { payer } = client
  const { version, ...shape } = SCHEMA
  const created = async (credential: Address, schema: Address, payTo: string, fields: Fields) => {
    const nonce = verdictNonce(payTo, fields.host)
    const data = serializeAttestationData((await fetchSchema(client.rpc, schema)).data, { ...fields })
    const expiry = fields.tested_at + 14n * DAY
    const create = await getCreateAttestationInstructionAsync({ authority: signer, credential, data, expiry, nonce, payer, schema })
    return { create, at: (await findAttestationPda({ credential, schema, nonce }))[0] }
  }
  const closing = (credential: Address, attestation: Address) =>
    getCloseAttestationInstruction({ attestation, authority: signer, credential, payer })
  return {
    credential: async (name: string): Promise<Address> => {
      await client.sendTransaction([await getCreateCredentialInstructionAsync({ authority: issuer, name, payer, signers: [signer.address] })])
      return (await findCredentialPda({ authority: issuer.address, name }))[0]
    },
    schema: async (credential: Address): Promise<Address> => {
      await client.sendTransaction([await getCreateSchemaInstructionAsync({ authority: issuer, credential, payer, ...shape })])
      return (await findSchemaPda({ credential, name: SCHEMA.name, version }))[0]
    },
    attest: async (credential: Address, schema: Address, payTo: string, fields: Fields): Promise<Address> => {
      const { create, at } = await created(credential, schema, payTo, fields)
      await client.sendTransaction([create])
      return at
    },
    renew: async (credential: Address, schema: Address, payTo: string, fields: Fields, attestation: Address): Promise<Address> => {
      const { create, at } = await created(credential, schema, payTo, fields)
      await client.sendTransaction([closing(credential, attestation), create])
      return at
    },
    close: async (credential: Address, attestation: Address): Promise<Address> => {
      await client.sendTransaction([closing(credential, attestation)])
      return attestation
    },
  }
}
