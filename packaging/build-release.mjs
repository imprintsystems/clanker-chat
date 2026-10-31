import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist'); mkdirSync(dist, { recursive: true });
const name = `agent-post-${pkg.version}.tar.gz`; const archive = join(dist, name);
// The archive contains dependencies, so a friend can use it without npm.
// It contains no home directory, identity keys, inboxes, or live tunnel state.
execFileSync('tar', ['-czf', archive, '-C', root, 'src', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'docs']);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(join(dist, `${name}.sha256`), `${digest}  ${name}\n`);
const url = process.env.AGENT_POST_RELEASE_URL || pathToFileURL(archive).href;
if (!/^(https:|file:)/.test(url)) throw new Error('Release URL must use HTTPS or a local file');
const formula = `class AgentPost < Formula
  desc "A paired local inbox for agents, exposed through MCP"
  homepage "https://github.com/ErikLit005/agent-post"
  url ${JSON.stringify(url)}
  version ${JSON.stringify(pkg.version)}
  sha256 ${JSON.stringify(digest)}

  depends_on "node@24"
  depends_on "cloudflared"

  def install
    libexec.install Dir["*"]
    (bin/"agent-post").write <<~SH
      #!/bin/sh
      export AGENT_POST_EXECUTABLE="#{opt_bin}/agent-post"
      export AGENT_POST_BREW_FORMULA="#{full_name}"
      export CLOUDFLARED_BIN="#{Formula["cloudflared"].opt_bin}/cloudflared"
      exec "#{Formula["node@24"].opt_bin}/node" "#{opt_libexec}/src/cli.js" "$@"
    SH
    chmod 0755, bin/"agent-post"
  end

  service do
    run [opt_bin/"agent-post", "start"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    log_path var/"log/agent-post.log"
    error_log_path var/"log/agent-post-error.log"
    restart_delay 5
    throttle_interval 5
  end

  def caveats
    <<~EOS
      Finish setup with:
        agent-post setup
      This starts the background service and connects Codex or Claude Code.
      To stop it:
        brew services stop #{full_name}
    EOS
  end

  test do
    assert_match "agent-post #{version}", shell_output("#{bin}/agent-post --help")
  end
end
`;
writeFileSync(join(dist, 'agent-post.rb'), formula);
console.log(JSON.stringify({ archive, sha256: digest, formula: join(dist, 'agent-post.rb'), scope: process.env.AGENT_POST_RELEASE_URL ? 'hosted archive URL supplied by operator' : 'local formula; rebuild with a hosted archive URL before distributing the formula' }, null, 2));
