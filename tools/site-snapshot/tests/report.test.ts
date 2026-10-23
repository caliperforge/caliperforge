import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { report, save } from '../report.ts'
import { read, type Snapshot } from '../snapshot.ts'

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const HEADERS = { 'x-powered-by': 'PHP/8.0.30', server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-LAX', 'strict-transport-security': 'max-age=31536000' }
const SITE = { url: 'https://example.org/', final: 'https://www.example.org/', status: 200, unread: [] }
const behind: Snapshot = {
  ...read(fixture('wordpress.html'), new Headers(HEADERS)), ...SITE,
  tls: { issuer: "Let's Encrypt", expires: 'Jan  1 00:00:00 2027 GMT' },
  nameservers: ['ada.ns.cloudflare.com'], cloudflareDns: true, latestWordpress: '6.6.1', phpSupported: false,
}
const plain: Snapshot = {
  ...read(fixture('plain.html'), new Headers()), ...SITE,
  tls: null, nameservers: null, cloudflareDns: null, latestWordpress: '6.6.1', phpSupported: null,
}

test('D1 save creates the folder and writes both reports', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'site-snapshot-')), 'out', 'example')
  expect(save(dir, behind)).toEqual({ json: join(dir, 'report.json'), md: join(dir, 'report.md') })
  expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))).toEqual(behind)
  expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe(report(behind))
})

test('D4 a hidden version reads as not shown, in both languages', () => {
  const md = report(plain)
  expect(md).toContain('- Version: not shown by the site')
  expect(md).toContain('- Versión: el sitio no lo muestra')
  expect(md).toContain('- PHP version: not shown by the site')
  expect(md).toContain('- Plugins: jetpack (version not shown)')
  expect(md).toContain('- TLS certificate: not read')
  expect(md).not.toContain('6.6.1')
})

test('D5 an unread source reads as not compared', () => {
  const md = report({ ...behind, latestWordpress: null, phpSupported: null })
  expect(md).toContain('- Version: 6.4.2, not compared')
  expect(md).toContain('- Versión de PHP: 8.0.30, no comparado')
})

test('D6 no wording calls a site vulnerable, in either language', () => {
  const md = report(behind)
  expect(md).toContain('- Version: 6.4.2, behind the latest release, 6.6.1')
  expect(md).toContain('- PHP version: 8.0.30, php.net no longer publishes security updates for PHP 8.0')
  expect(md).toContain('- Strict Transport Security header: present')
  expect(md).toContain('- Content Security Policy header: missing')
  expect(md).toContain('## Español')
  for (const s of [behind, plain]) expect(report(s)).not.toMatch(/vulnerab/i)
})
