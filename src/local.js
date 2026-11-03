import http from 'node:http';
import { join } from 'node:path';
import { MAX_BODY } from './protocol.js';

export const socketPath = home => join(home, 'daemon.sock');
export async function readJSON(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse((chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)).toString());
}
export function json(response, status, value) {
  if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
// Inside an answer to a bridge question, every local call says so, and the
// daemon lets it only read: an answer cannot ask back or start other work.
export function localCall(home, command, args = {}, client, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...(process.env.CLANKER_BRIDGE_RUN ? { 'x-clanker-run': process.env.CLANKER_BRIDGE_RUN } : {}), ...(client ? { 'x-clanker-origin': 'mcp', 'x-clanker-client': client.id || '', 'x-clanker-token': client.token || '', ...(client.worker ? { 'x-clanker-worker':client.worker } : {}) } : {}) };
    const request = http.request({ socketPath: socketPath(home), path: '/local', method: 'POST', headers }, async response => {
      try {
        const value = await readJSON(response);
        if (response.statusCode !== 200) reject(new Error(value.error || 'Local request failed'));
        else resolve(value);
      } catch (error) { reject(error); }
    });
    // A wall-clock deadline also bounds stalled/dribbling responses, rather than
    // merely timing out an idle socket. Destroying the request cancels its I/O.
    const timer = setTimeout(() => request.destroy(new Error('Local request timed out')), timeout);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(JSON.stringify({ command, args }));
  });
}
