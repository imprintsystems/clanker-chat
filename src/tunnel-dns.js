import { lookup as systemLookup } from 'node:dns';
import { isIP } from 'node:net';

const TUNNEL = /^[a-z0-9-]+\.trycloudflare\.com$/;
const RETRY_MS = 30_000, MAX_TTL_MS = 300_000, MAX_ENTRIES = 256;

// New Quick Tunnel names can hit a negative system-resolver cache. Share one
// bounded fallback per name, including a short cooldown after failure: offline
// contacts must not cause a fresh HTTPS DNS request on every delivery attempt.
// System DNS always gets the first chance; TLS still verifies the tunnel name.
export function createTunnelLookup({ lookup = systemLookup, fetch = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  return (hostname, options, callback) => {
    lookup(hostname, options, (error, address, family) => {
      if (!error || error.code !== 'ENOTFOUND' || !TUNNEL.test(hostname) || options?.family === 6) return callback(error, address, family);
      let entry = cache.get(hostname);
      if (entry && !entry.pending && now() >= entry.until) { cache.delete(hostname); entry = undefined; }
      if (!entry) {
        // Never evict in-flight work, which would allow duplicate requests.
        if (cache.size >= MAX_ENTRIES) {
          const oldest = [...cache].find(([, value]) => !value.pending);
          if (!oldest) return callback(error);
          cache.delete(oldest[0]);
        }
        entry = { pending: true };
        cache.set(hostname, entry);
        entry.promise = resolveTunnel(hostname, fetch).then(result => {
          entry.address = result.address; entry.until = now() + result.ttl;
        }, () => { entry.until = now() + RETRY_MS; }).finally(() => { entry.pending = false; });
      }
      entry.promise.then(() => {
        if (!entry.address) return callback(error);
        if (options?.all) callback(null, [{ address: entry.address, family: 4 }]);
        else callback(null, entry.address, 4);
      });
    });
  };
}

async function resolveTunnel(hostname, fetch) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(4_000) });
  try {
    if (!response.ok) throw new Error('DNS fallback unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 8192) throw new Error('DNS response too large'); chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks, size).toString());
    const answer = result.Status === 0 && result.Answer?.find(answer => answer.type === 1 && isIP(answer.data) === 4);
    const ip = answer?.data;
    if (!ip || /^(0|10|127|169\.254|192\.168)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) throw new Error('DNS fallback returned no public IPv4 address');
    const ttl = Number.isFinite(answer.TTL) ? Math.max(0, Math.min(MAX_TTL_MS, answer.TTL * 1000)) : RETRY_MS;
    return { address: ip, ttl };
  } finally { await response.body?.cancel().catch(() => {}); }
}
