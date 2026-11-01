import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist'); mkdirSync(dist, { recursive: true });
const name = `${pkg.name}-${pkg.version}.tar.gz`; const archive = join(dist, name);
// The archive contains dependencies, so a friend can use it without npm.
// It contains no home directory, identity keys, inboxes, or live tunnel state.
const metadataOptions = process.platform === 'darwin'
  ? ['--no-mac-metadata', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
  : ['--owner=0', '--group=0', '--numeric-owner'];
// Zod's published source tests contain sample tokens. They are not runtime
// dependencies and need not be distributed with this app. Keep package licences.
const excludeFixtures = ['--exclude=__pycache__', '--exclude=*.pyc', '--exclude=node_modules/.package-lock.json', '--exclude=node_modules/zod/src/*/tests', '--exclude=node_modules/zod/src/*/*/tests'];
execFileSync('tar', [...metadataOptions, ...excludeFixtures, '-czf', archive, '-C', root, 'src', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'docs'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
const allowedRoots = new Set(['src', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'docs']);
const forbidden = entries.filter(name => {
  const parts = name.split('/').filter(Boolean);
  return name.startsWith('/') || parts.includes('..') || !allowedRoots.has(parts[0]) || parts.some(part => /^(\.git|\.env(?:\..*)?|\._.*|\.DS_Store|profile\.json|clients\.json|integrations\.json|backups|__pycache__)$/.test(part)) || /\.(db(?:-(?:wal|shm))?|sqlite3?|pem|key|p12|pfx|sock|log|pyc)$/.test(name);
});
if (forbidden.length) throw new Error(`Release contains forbidden entries: ${forbidden.join(', ')}`);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(join(dist, `${name}.sha256`), `${digest}  ${name}\n`);
const url = process.env.CLANKER_RELEASE_URL || pathToFileURL(archive).href;
if (!/^(https:|file:)/.test(url)) throw new Error('Release URL must use HTTPS or a local file');
const formula = `class Clanker < Formula
  desc "A paired local inbox for agents, exposed through MCP"
  homepage "https://github.com/imprintsystems/clanker-chat"
  url ${JSON.stringify(url)}
  version ${JSON.stringify(pkg.version)}
  sha256 ${JSON.stringify(digest)}

  depends_on "node@24"
  depends_on "cloudflared"

  def install
    libexec.install Dir["*"]
    (bin/"clanker").write <<~SH
      #!/bin/sh
      export CLANKER_EXECUTABLE="#{opt_bin}/clanker"
      export CLANKER_BREW_FORMULA="#{full_name}"
      export CLOUDFLARED_BIN="#{Formula["cloudflared"].opt_bin}/cloudflared"
      exec "#{Formula["node@24"].opt_bin}/node" "#{opt_libexec}/src/cli.js" "$@"
    SH
    chmod 0755, bin/"clanker"
  end

  service do
    run [opt_bin/"clanker", "start"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    log_path var/"log/clanker.log"
    error_log_path var/"log/clanker-error.log"
    restart_delay 5
    throttle_interval 5
  end

  def caveats
    <<~EOS
      Finish setup with:
        clanker setup
      Choose which agent apps can access your inbox.
      Setup starts the background service and saves their MCP connections.
      To stop it:
        brew services stop #{full_name}
    EOS
  end

  test do
    assert_match "clanker #{version}", shell_output("#{bin}/clanker --help")
  end
end
`;
writeFileSync(join(dist, 'clanker.rb'), formula);
console.log(JSON.stringify({ archive, sha256: digest, formula: join(dist, 'clanker.rb'), scope: process.env.CLANKER_RELEASE_URL ? 'hosted archive URL supplied by operator' : 'local formula; rebuild with a hosted archive URL before distributing the formula' }, null, 2));
