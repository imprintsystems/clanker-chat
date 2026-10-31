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
  return JSON.parse(Buffer.concat(chunks).toString());
}
export function json(response, status, value) {
  if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
export function localCall(home, command, args = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socketPath(home), path: '/local', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 30_000 }, async response => {
      try {
        const value = await readJSON(response);
        if (response.statusCode !== 200) reject(new Error(value.error || 'Local request failed'));
        else resolve(value);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Local request timed out')));
    request.end(JSON.stringify({ command, args }));
  });
}
