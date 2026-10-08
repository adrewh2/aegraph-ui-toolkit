/**
 * Which addresses are the public internet. The headless engine's `fetch` (`src/headless/publicFetch.ts`) reaches only
 * those: a URL a tool is handed comes from workspace data — a bundle someone sent, a page the model read — and that
 * process runs outside any browser, with no CORS and on the developer's network. Unchecked, a fetch is a request
 * forgery into everything the machine can reach: the loopback, the office LAN, a cloud metadata endpoint.
 *
 * Every address a name resolves to must be public, checked in the socket's own lookup (`publicLookup`), so a name
 * cannot resolve one way for a check and another for the connection.
 *
 * The bridge (`server.mjs`) fetches nothing, not even from a public address: a request made there would be one no one
 * agreed to, and the URL — or its DNS name — can carry whatever it was made to. The tab fetches an image itself,
 * after asking.
 */
import dns from 'node:dns'
import net from 'node:net'

// Two lists: Node's BlockList maps IPv4 into ::ffff:0:0/96, so one list holding that range would block every IPv4.
const blocked4 = new net.BlockList()
const blocked6 = new net.BlockList()
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(a, bits, 'ipv4')
for (const [a, bits] of [
  // `::/96` holds the unspecified address, loopback and the deprecated IPv4-compatible range (`::a9fe:a9fe`).
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked6.addSubnet(a, bits, 'ipv6')

/** Whether an IP address is on the public internet (not loopback, private, link-local, metadata, reserved…). */
export function isPublicAddress(ip) {
  const v = net.isIP(ip)
  if (!v) return false
  if (v === 4) return !blocked4.check(ip, 'ipv4')
  // An IPv4-mapped address (::ffff:a.b.c.d, however written) is an IPv4 address in disguise: never needed for a public
  // fetch, so refused outright rather than unpacked.
  if (/^(0{0,4}:){0,5}:?ffff:/i.test(ip) || /^::ffff:/i.test(ip)) return false
  return !blocked6.check(ip, 'ipv6')
}

/** `dns.lookup`, refusing a name that resolves to any address that is not public. */
export function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const bad = addresses.find((a) => !isPublicAddress(a.address))
    if (bad) return callback(Object.assign(new Error(`${hostname} resolves to ${bad.address}, which is not a public address`), { code: 'EPUBLICONLY' }))
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}
