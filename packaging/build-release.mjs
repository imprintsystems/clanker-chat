import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { releaseArchive } from './archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Pin the build toolchain, not the minimum runtime supported by the inbox.
const buildNode = '26.13.0', buildNpm = '11.20.0';
if (process.versions.node !== buildNode || execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim() !== buildNpm) throw new Error(`Build releases with Node ${buildNode} and npm ${buildNpm}`);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', '--verify', `${process.env.CLANKER_RELEASE_REF || 'HEAD'}^{commit}`]);
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? git(['show', '-s', '--format=%ct', commit]));
if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0o77777777777) throw new Error('Invalid SOURCE_DATE_EPOCH');
const dist = resolve(process.env.CLANKER_RELEASE_DIR || join(root, 'dist'));
mkdirSync(dist, { recursive: true });
const stage = mkdtempSync(join(tmpdir(), 'clanker-release-'));
let pkg, name, archive, digest, tarDigest;
try {
  const source = join(stage, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', source, commit], { cwd: root });
  const tree = join(stage, 'tree'); mkdirSync(tree);
  execFileSync('tar', ['-xf', source, '-C', tree], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  pkg = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
  // Never bundle the developer's node_modules or execute dependency lifecycle hooks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const userConfig = join(stage, 'user.npmrc'), globalConfig = join(stage, 'global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(tree, 'SOURCE.json'), JSON.stringify({ repository: 'https://github.com/imprintsystems/clanker-chat', commit, sourceDateEpoch: epoch, node: buildNode, npm: buildNpm }) + '\n');
  name = `${pkg.name}-${pkg.version}.tar.gz`; archive = join(dist, name);
  const bytes = releaseArchive(tree, ['src', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'docs', 'SOURCE.json'], epoch);
  writeFileSync(archive, bytes);
  digest = createHash('sha256').update(bytes).digest('hex');
  // zlib's deflate output differs between CPU architectures, so the
  // uncompressed tar is what any machine reproduces byte for byte.
  tarDigest = createHash('sha256').update(gunzipSync(bytes)).digest('hex');
  writeFileSync(join(dist, `${name}.sha256`), `${digest}  ${name}\n`);
} finally { rmSync(stage, { recursive: true, force: true }); }
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
console.log(JSON.stringify({ archive, sha256: digest, tarSha256: tarDigest, commit, sourceDateEpoch: epoch, formula: join(dist, 'clanker.rb'), scope: process.env.CLANKER_RELEASE_URL ? 'hosted archive URL supplied by operator' : 'local formula; rebuild with a hosted archive URL before distributing the formula' }, null, 2));
