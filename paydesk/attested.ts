import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchMaybeAttestation, findAttestationPda, findCredentialPda, findSchemaPda } from '@solana/attestation'
import type { Address, TransactionSigner } from '@solana/kit'
import { usable, type Probe as Probed } from './assess.ts'
import { attestOps, SCHEMA, verdictNonce, type Fields } from './attest.ts'
import { overall, type ListingScan } from './card.ts'
import type { Row } from './prs.ts'
import { answer, sender, type Net } from './scan.ts'

export type Probe = (url: string, method: string) => Promise<Probed>
export interface Chain { ops: ReturnType<typeof attestOps>; exists(at: Address): Promise<boolean>; attested(at: Address): Promise<boolean> }
interface Options { issuer: Address; credential: string; out: string; dryRun: boolean }
interface Reprobed { e: ListingScan['endpoints'][number]; resourceUrl: string | null; payees: string[] }

export const probe = (net: Net): Probe => {
  const send = sender(net)
  return (url, method) => answer(send(url, method, {}))
}

export function chain(client: Parameters<typeof attestOps>[0], issuer: TransactionSigner, signer: TransactionSigner): Chain {
  return {
    ops: attestOps(client, issuer, signer),
    exists: async (at) => (await client.rpc.getAccountInfo(at, { encoding: 'base64' }).send()).value !== null,
    attested: async (at) => (await fetchMaybeAttestation(client.rpc, at)).exists,
  }
}

export async function attested(rows: Row[], testedAt: Date, { issuer, credential, out, dryRun }: Options, probe: Probe, chain: Chain): Promise<string[]> {
  const cred = (await findCredentialPda({ authority: issuer, name: credential }))[0]
  const sch = (await findSchemaPda({ credential: cred, name: SCHEMA.name, version: SCHEMA.version }))[0]
  let made = false
  const send = async (payee: string, fields: Fields, at: Address, renew: boolean): Promise<Address> => {
    if (!made) {
      if (!(await chain.exists(cred))) await chain.ops.credential(credential)
      if (!(await chain.exists(sch))) await chain.ops.schema(cred)
      made = true
    }
    return renew ? chain.ops.renew(cred, sch, payee, fields, at) : chain.ops.attest(cred, sch, payee, fields)
  }
  const lines: string[] = []
  for (const row of rows.filter((r): r is ListingScan => 'endpoints' in r && overall(r) === 'pass')) {
    for (const [host, probed] of await hosts(row, probe)) {
      const payees = [...new Set(probed.flatMap((p) => p.payees))]
      const [payee] = payees
      if (payees.length > 1 || payee === undefined) {
        lines.push(`${row.fqn} ${host} - skipped ${payee === undefined ? 'no payee' : 'payees differ'}`)
        continue
      }
      const fields = evidence(row, host, payee, probed, testedAt, out)
      const at = (await findAttestationPda({ credential: cred, schema: sch, nonce: verdictNonce(payee, host) }))[0]
      const renew = await chain.attested(at)
      const verb = renew ? 'renew' : 'attest'
      lines.push(`${row.fqn} ${host} ${payee} ${dryRun ? `would ${verb} ${at}` : `${verb}ed ${await send(payee, fields, at, renew)}`}`)
    }
  }
  return lines
}

async function hosts(row: ListingScan, probe: Probe): Promise<Map<string, Reprobed[]>> {
  const base = row.serviceUrl.replace(/\/+$/, '')
  const grouped = new Map<string, Reprobed[]>()
  for (const e of row.endpoints) {
    const p = await probe(base + e.path.replace(/\{[^}]+\}/g, 'test'), e.method)
    const resourceUrl = 'error' in p ? null : p.offers.resourceUrl
    const payees = 'error' in p ? [] : usable(p.offers.offers).flatMap((o) => (o.payTo === null ? [] : [o.payTo]))
    const host = (URL.parse(resourceUrl ?? '')?.hostname ?? row.host).toLowerCase()
    grouped.set(host, [...(grouped.get(host) ?? []), { e, resourceUrl, payees }])
  }
  return grouped
}

function evidence(row: ListingScan, host: string, payee: string, probed: Reprobed[], testedAt: Date, out: string): Fields {
  const report = join(out, row.fqn, `${host}.json`)
  const endpoints = probed.map(({ e, resourceUrl }) => ({ method: e.method, path: e.path, verdict: e.verdict, protocols: e.protocols, issues: e.issues, resourceUrl }))
  const bytes = Buffer.from(JSON.stringify({ listing: row.fqn, host, payee, tested_at: testedAt.toISOString(), endpoints }, null, 2))
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, bytes)
  const offered = (proto: string): boolean => probed.some(({ e }) => e.protocols.includes(proto))
  return {
    listing: row.fqn, host, level: 2, protocols: (offered('x402') ? 1 : 0) | (offered('mpp') ? 2 : 0), price_ok: false, delivers: false,
    checks_passed: probed.filter(({ e }) => e.verdict === 'ok').length, checks_total: probed.length,
    tested_at: BigInt(Math.floor(testedAt.getTime() / 1000)), report_uri: report, report_sha256: [...createHash('sha256').update(bytes).digest()],
  }
}
