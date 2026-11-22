import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { findAttestationPda, findCredentialPda, findSchemaPda } from '@solana/attestation'
import { createClient, createKeyPairSignerFromBytes, type Address, type KeyPairSigner } from '@solana/kit'
import { solanaRpc } from '@solana/kit-plugin-rpc'
import { payer } from '@solana/kit-plugin-signer'
import { SCHEMA, verdictNonce } from './attest.ts'
import { attested, chain as built, probe as prober, type Chain, type Probe } from './attested.ts'
import type { Row } from './prs.ts'
import type { Net } from './scan.ts'

const NET: Net = { fetch, resolve: (host) => lookup(host) }

export interface Renewed { attested: number; renewed: number; closed: number; skipped: number }
interface Config { rpc: string; credential: string; issuer: string; signer: string }
interface Evidence { path: string; listing: string; host: string; payee: string }

const keypair = async (file: string): Promise<KeyPairSigner> =>
  createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(file, 'utf8')) as number[]))

async function connected(config: Config): Promise<{ issuer: Address; chain: Chain }> {
  const issuer = await keypair(config.issuer)
  const signer = await keypair(config.signer)
  const client = createClient().use(payer(issuer)).use(solanaRpc({ rpcUrl: config.rpc }))
  return { issuer: issuer.address, chain: built(client, issuer, signer) }
}

function configOf(root: string): Config {
  const path = join(root, '.cf/attest/config.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Config
  } catch {
    throw new Error(`no attest config at ${path}`)
  }
}

export async function renew(root: string, date: string, chain: (config: Config) => Promise<{ issuer: Address; chain: Chain }> = connected,
  probe: Probe = prober(NET)): Promise<Renewed> {
  const config = configOf(root)
  const out = join(root, '.cf/attest/evidence')
  const kept = (existsSync(out) ? readdirSync(out, { recursive: true, encoding: 'utf8' }) : []).filter((p) => p.endsWith('.json'))
    .map((path): Evidence => ({ ...(JSON.parse(readFileSync(join(out, path), 'utf8')) as Omit<Evidence, 'path'>), path }))
  const { issuer, chain: c } = await chain({ ...config, issuer: resolve(root, config.issuer), signer: resolve(root, config.signer) })
  const file = join(root, '.cf/paydesk', `live-${date}.jsonl`)
  const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Row)
  const lines = await attested(rows, statSync(file).mtime, { issuer, credential: config.credential, out, dryRun: false }, probe, c)
  const words = lines.map((l) => l.split(' '))
  const named = new Set(words.map((w) => w.slice(0, 2).join(' ')))
  const cred = (await findCredentialPda({ authority: issuer, name: config.credential }))[0]
  const sch = (await findSchemaPda({ credential: cred, name: SCHEMA.name, version: SCHEMA.version }))[0]
  let closed = 0
  for (const e of kept.filter((k) => !named.has(`${k.listing} ${k.host}`))) {
    const at = (await findAttestationPda({ credential: cred, schema: sch, nonce: verdictNonce(e.payee, e.host) }))[0]
    if (await c.attested(at)) {
      await c.ops.close(cred, at)
      closed++
    }
    const to = join(root, '.cf/attest/closed', date, e.path)
    mkdirSync(dirname(to), { recursive: true })
    renameSync(join(out, e.path), to)
  }
  const count = (verb: string): number => words.filter((w) => w[3] === verb).length
  return { attested: count('attested'), renewed: count('renewed'), closed, skipped: lines.filter((l) => l.includes(' - skipped ')).length }
}
