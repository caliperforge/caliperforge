import { resolveNs } from 'node:dns/promises'
import { connect, type TLSSocket } from 'node:tls'
import { parseArgs } from 'node:util'
import { save } from './report.ts'
import { snapshot, type Net, type Tls } from './snapshot.ts'

const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { out: { type: 'string' } }, allowPositionals: true })
const [url] = positionals
if (url === undefined || values.out === undefined || !/^https?:\/\//i.test(url)) {
  process.stderr.write('usage: node tools/site-snapshot/run.ts <http(s) url> --out <dir>\n')
  process.exit(1)
}

const tls = (host: string): Promise<Tls> => new Promise<TLSSocket>((resolve, reject) => {
  const socket = connect({ host, port: 443, servername: host })
  socket.setTimeout(15_000, () => socket.destroy(new Error(`${host}:443 timed out`)))
  socket.once('secureConnect', () => { resolve(socket) }).once('error', reject)
}).then((socket) => {
  const { issuer, valid_to } = socket.getPeerCertificate()
  socket.end()
  const name = issuer.O ?? issuer.CN
  if (name === undefined) throw new Error(`${host}: the certificate names no issuer`)
  return { issuer: [name].flat().join(', '), expires: valid_to }
})

const net: Net = { fetch, tls, ns: resolveNs }
const { json, md } = save(values.out, await snapshot(url, net))
process.stdout.write(`${json}\n${md}\n`)
