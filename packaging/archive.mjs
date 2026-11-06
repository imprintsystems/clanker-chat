import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

// Write a portable tar directly: host tar implementations disagree about pax
// headers, metadata and traversal order, even when given equivalent flags.
export function releaseArchive(root, roots, epoch) {
  const chunks = [], entries = [];
  function collect(name) {
    if (name === 'node_modules/.package-lock.json' || /(^|\/)(__pycache__|\.DS_Store|\._[^/]*)($|\/)|\.pyc$/.test(name) || /^node_modules\/zod\/src\/(?:[^/]+\/){1,2}tests(?:\/|$)/.test(name)) return;
    const stat = lstatSync(join(root, name)); entries.push({ name, stat });
    if (stat.isDirectory()) for (const child of readdirSync(join(root, name)).sort()) collect(`${name}/${child}`);
  }
  for (const name of roots) collect(name);
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  function header(name, mode, size, type, link = '') {
    const block = Buffer.alloc(512);
    const text = (value, at, length) => { if (Buffer.byteLength(value) > length) throw new Error(`Tar field too long: ${value}`); block.write(value, at, length, 'utf8'); };
    const octal = (value, at, length) => text(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
    text(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(size, 124, 12); octal(epoch, 136, 12); block.fill(32, 148, 156);
    text(type, 156, 1); text(link, 157, 100); text('ustar\0', 257, 6); text('00', 263, 2);
    const sum = block.reduce((n, byte) => n + byte, 0);
    text(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(block);
  }
  function body(data) { chunks.push(data); if (data.length % 512) chunks.push(Buffer.alloc(512 - data.length % 512)); }
  function pax(key, value) {
    const record = `${key}=${value}\n`; let length = Buffer.byteLength(record) + 2;
    while (Buffer.byteLength(record) + String(length).length + 1 !== length) length = Buffer.byteLength(record) + String(length).length + 1;
    return `${length} ${record}`;
  }
  for (const { name, stat } of entries) {
    const parts = name.split('/');
    if (isAbsolute(name) || parts.includes('..') || parts.some(part => /^(\.git|\.env(?:\..*)?|profile\.json|clients\.json|integrations\.json|backups)$/.test(part)) || /\.(db(?:-(?:wal|shm))?|sqlite3?|pem|key|p12|pfx|sock|log)$/.test(name)) throw new Error(`Release contains forbidden entry: ${name}`);
    const directory = stat.isDirectory(), symlink = stat.isSymbolicLink();
    if (!directory && !symlink && !stat.isFile()) throw new Error(`Unsupported release entry: ${name}`);
    const path = name + (directory ? '/' : ''), link = symlink ? readlinkSync(join(root, name)) : '';
    if (symlink && (isAbsolute(link) || relative(root, resolve(root, dirname(name), link)).startsWith('..'))) throw new Error(`Unsafe release symlink: ${name}`);
    let extended = '';
    if (Buffer.byteLength(path) > 100) extended += pax('path', path);
    if (Buffer.byteLength(link) > 100) extended += pax('linkpath', link);
    if (extended) { const data = Buffer.from(extended); header('PaxHeader', 0o644, data.length, 'x'); body(data); }
    const data = stat.isFile() ? readFileSync(join(root, name)) : Buffer.alloc(0);
    header(Buffer.byteLength(path) > 100 ? 'PaxEntry' : path, directory ? 0o755 : symlink ? 0o777 : stat.mode & 0o111 ? 0o755 : 0o644, data.length, directory ? '5' : symlink ? '2' : '0', Buffer.byteLength(link) > 100 ? '' : link);
    body(data);
  }
  chunks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  // No timestamp/name; normalize gzip's OS byte as well as tar ownership.
  compressed.writeUInt32LE(0, 4); compressed[9] = 255;
  return compressed;
}
