/**
 * A resolver-scoped DNS fallback for the read-only shadow scripts.
 *
 * 2026-09-17: the LAN router (192.168.50.1) started answering NXDOMAIN for
 * `api.open-meteo.com` while every other name the project uses still resolved
 * (`ensemble-api.open-meteo.com` included). The HRRR shadow stopped collecting
 * at 08:20Z and lost an hour of forecasts per hour; incident
 * data/sentinel/incidents/2026-09-17T10-50-hrrr-stale.md has the evidence.
 *
 * Changing the box's or the router's resolver would redirect the LIVE trading
 * app's venue lookups at the same time, which is not a change to make
 * unattended. This helper is the narrow alternative: ONE process, ONE request
 * path. The normal `fetch` is tried first and is what serves every request that
 * works; only a DNS failure falls back to a public resolver, and only for the
 * script that imports this.
 *
 * Note for the next reader: `dns.setServers()` would NOT have worked here. It
 * rebinds `dns.resolve*`, while `fetch`/undici connects through `dns.lookup`
 * (getaddrinfo, i.e. the system resolver). The fallback therefore resolves the
 * name itself and hands `node:https` an explicit `lookup`.
 */
import { request as httpsRequest } from 'node:https'
import { Resolver } from 'node:dns'

export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8']

/**
 * True for the failures that mean "the name did not resolve", and only those.
 * `fetch` wraps the underlying error in `cause`; `node:https` throws it bare.
 * A refused connection or a TLS error is NOT a DNS failure and must keep its
 * own error — retrying those against another resolver would hide a real fault.
 */
export function isDnsFailure(err) {
  const code = err?.cause?.code ?? err?.code
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN'
}

/**
 * A `lookup` implementation with the signature `net.connect` expects, backed by
 * an explicit resolver instead of the system one.
 * @param {string[]} servers
 * @param {{ setServers: Function, resolve4: Function }} [resolver] injectable for tests
 */
export function makeResolverLookup(servers = PUBLIC_RESOLVERS, resolver = new Resolver()) {
  resolver.setServers(servers)
  return function lookup(hostname, options, cb) {
    const done = typeof options === 'function' ? options : cb
    const opts = typeof options === 'function' ? {} : (options ?? {})
    resolver.resolve4(hostname, (err, addresses) => {
      if (err) return done(err)
      if (!addresses || addresses.length === 0) return done(new Error(`no A record for ${hostname} at ${servers.join(', ')}`))
      if (opts.all) return done(null, addresses.map((address) => ({ address, family: 4 })))
      done(null, addresses[0], 4)
    })
  }
}

/** GET one JSON document over https with an explicit `lookup`. */
export function getJsonVia(url, { headers = {}, timeoutMs = 20_000, lookup } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { headers, lookup, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${String(url).slice(0, 80)} -> ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error(`GET ${String(url).slice(0, 80)} -> unparseable JSON: ${e instanceof Error ? e.message : String(e)}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`GET ${String(url).slice(0, 80)} -> timeout after ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end()
  })
}

/**
 * `fetch` the JSON at `url`; on a DNS failure only, retry once through the
 * public resolvers. Everything else propagates untouched.
 */
export async function getJsonWithDnsFallback(url, { headers = {}, timeoutMs = 20_000, lookup, onFallback } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`GET ${String(url).slice(0, 80)} -> ${res.status}`)
    return await res.json()
  } catch (e) {
    if (!isDnsFailure(e)) throw e
    onFallback?.(new URL(url).hostname)
    return getJsonVia(url, { headers, timeoutMs, lookup: lookup ?? makeResolverLookup() })
  }
}
