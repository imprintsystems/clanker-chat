// OpenCode 2 has no inline per-run config flag. Create a private native server
// and a session with explicit permissions, then use its actual CLI JSONL output.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

const [binary, tools] = process.argv.slice(2);
const env = { ...process.env, OPENCODE_PASSWORD: randomBytes(32).toString('hex') };
const headers = { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}` };
let server, cli, base, session;
const stop = () => { cli?.kill('SIGTERM'); server?.kill('SIGTERM'); };
process.once('SIGTERM', () => { stop(); process.exitCode = 1; });
process.once('SIGINT', () => { stop(); process.exitCode = 1; });
const request = async (path, method, body) => {
  const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenCode ${method} ${path} failed (${response.status}).`);
  return response.status === 204 ? undefined : (await response.json()).data;
};
try {
  if (!binary || !isAbsolute(binary)) throw new Error('OpenCode needs an approved absolute executable path.');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  base = await new Promise((resolve, reject) => {
    let output = '';
    server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    server.stderr.pipe(process.stderr);
    const timer = setTimeout(() => reject(new Error('OpenCode private server did not start.')), 20_000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('OpenCode private server exited before startup.')); });
    server.stdout.on('data', chunk => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      try {
        const value = JSON.parse(output.slice(0, end));
        const url = new URL(value.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid OpenCode private endpoint.');
        clearTimeout(timer); resolve(url.origin);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  const permissions = [{ action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' }))];
  session = await request('/api/session', 'POST', { location: { directory: process.cwd() }, title: 'Clanker bridge answer',
    ...(tools === 'read-only' ? { permissions } : {}) });
  cli = spawn(binary, ['run', '--server', base, '--session', session.id, '--format', 'json'], { env, stdio: ['pipe', 'inherit', 'inherit'] });
  cli.stdin.on('error', () => {});
  cli.stdin.end(prompt);
  process.exitCode = await new Promise((resolve, reject) => { cli.once('error', reject); cli.once('close', code => resolve(code ?? 1)); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (session && base) { try { await request(`/api/session/${encodeURIComponent(session.id)}`, 'DELETE'); } catch { /* The private host may already have stopped. */ } }
  stop();
  if (server && server.exitCode === null) await new Promise(resolve => { server.once('close', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000).unref(); });
}
