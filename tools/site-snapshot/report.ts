import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Named, Snapshot } from './snapshot.ts'

const EN = {
  heading: 'English',
  labels: {
    address: 'Address read', cms: 'Content management system', version: 'Version', plugins: 'Plugins', themes: 'Themes',
    php: 'PHP version', server: 'Web server', hsts: 'Strict Transport Security header', csp: 'Content Security Policy header',
    frameOptions: 'X-Frame-Options header', tls: 'TLS certificate', ns: 'Nameservers', front: 'Cloudflare in front of the site',
    dns: 'DNS on Cloudflare',
  },
  unshown: 'not shown by the site',
  uncompared: 'not compared',
  unread: 'not read',
  none: 'none seen',
  noVersion: 'version not shown',
  present: 'present',
  missing: 'missing',
  yes: 'yes',
  no: 'no',
  latest: 'the latest release',
  behind: (latest: string) => `behind the latest release, ${latest}`,
  phpOld: (branch: string) => `php.net no longer publishes security updates for PHP ${branch}`,
  phpOk: (branch: string) => `php.net still publishes security updates for PHP ${branch}`,
  issued: (issuer: string, expires: string) => `issued by ${issuer}, expires ${expires}`,
}

const ES: typeof EN = {
  heading: 'Español',
  labels: {
    address: 'Dirección leída', cms: 'Sistema de gestión de contenidos', version: 'Versión', plugins: 'Plugins', themes: 'Temas',
    php: 'Versión de PHP', server: 'Servidor web', hsts: 'Cabecera Strict Transport Security', csp: 'Cabecera Content Security Policy',
    frameOptions: 'Cabecera X-Frame-Options', tls: 'Certificado TLS', ns: 'Servidores de nombres', front: 'Cloudflare delante del sitio',
    dns: 'DNS en Cloudflare',
  },
  unshown: 'el sitio no lo muestra',
  uncompared: 'no comparado',
  unread: 'no leído',
  none: 'ninguno visto',
  noVersion: 'versión no mostrada',
  present: 'presente',
  missing: 'ausente',
  yes: 'sí',
  no: 'no',
  latest: 'la última versión',
  behind: (latest: string) => `por detrás de la última versión, ${latest}`,
  phpOld: (branch: string) => `php.net ya no publica actualizaciones de seguridad para PHP ${branch}`,
  phpOk: (branch: string) => `php.net aún publica actualizaciones de seguridad para PHP ${branch}`,
  issued: (issuer: string, expires: string) => `emitido por ${issuer}, caduca ${expires}`,
}

type Words = typeof EN

export function report(s: Snapshot): string {
  return [`# Site snapshot: ${s.url}`, '', ...section(s, EN), '', ...section(s, ES), ''].join('\n')
}

export function save(dir: string, s: Snapshot): { json: string; md: string } {
  mkdirSync(dir, { recursive: true })
  const json = join(dir, 'report.json')
  const md = join(dir, 'report.md')
  writeFileSync(json, JSON.stringify(s, null, 2))
  writeFileSync(md, report(s))
  return { json, md }
}

function section(s: Snapshot, w: Words): string[] {
  const has = (on: boolean): string => (on ? w.present : w.missing)
  const yes = (on: boolean | null): string => (on === null ? w.unread : on ? w.yes : w.no)
  const { labels: l } = w
  const rows: [string, string][] = [
    [l.address, `${s.final} (HTTP ${String(s.status)})`],
    [l.cms, s.generator?.name ?? w.unshown],
    [l.version, version(s, w)],
    [l.plugins, named(s.plugins, w)],
    [l.themes, named(s.themes, w)],
    [l.php, php(s, w)],
    [l.server, s.server ?? w.unshown],
    [l.hsts, has(s.headers.hsts)],
    [l.csp, has(s.headers.csp)],
    [l.frameOptions, has(s.headers.frameOptions)],
    [l.tls, s.tls === null ? w.unread : w.issued(s.tls.issuer, s.tls.expires)],
    [l.ns, s.nameservers === null ? w.unread : s.nameservers.join(', ')],
    [l.front, yes(s.cloudflare)],
    [l.dns, yes(s.cloudflareDns)],
  ]
  return [`## ${w.heading}`, '', ...rows.map(([label, value]) => `- ${label}: ${value}`)]
}

function version(s: Snapshot, w: Words): string {
  const shown = s.generator?.version ?? null
  if (shown === null) return w.unshown
  if (s.generator?.name !== 'WordPress') return shown
  if (s.latestWordpress === null) return `${shown}, ${w.uncompared}`
  const older = shown.localeCompare(s.latestWordpress, undefined, { numeric: true }) < 0
  return `${shown}, ${older ? w.behind(s.latestWordpress) : w.latest}`
}

function php(s: Snapshot, w: Words): string {
  if (s.php === null) return w.unshown
  const branch = s.php.split('.').slice(0, 2).join('.')
  if (s.phpSupported === null) return `${s.php}, ${w.uncompared}`
  return `${s.php}, ${s.phpSupported ? w.phpOk(branch) : w.phpOld(branch)}`
}

function named(list: Named[], w: Words): string {
  if (list.length === 0) return w.none
  return list.map((n) => `${n.name} ${n.version ?? `(${w.noVersion})`}`).join(', ')
}
