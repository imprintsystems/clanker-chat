import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parse, modify, applyEdits } from 'jsonc-parser';

const digest = text => createHash('sha256').update(text).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const assets = fileURLToPath(new URL('./integrations/', import.meta.url));
function managedFile(path, contents, home, client, remove, write) {
  const registry = join(home,'integrations.json');
  const saved = existsSync(registry) ? JSON.parse(readFileSync(registry,'utf8')) : {};
  const original = existsSync(path) ? readFileSync(path,'utf8') : '';
  if (original && original !== contents && saved[path] !== digest(original)) throw new Error(`${client.label} notification file was edited or belongs to another integration. It was left unchanged.`);
  if (remove) {
    if (original) unlinkSync(path);
    if (!Object.hasOwn(saved,path)) return;
    delete saved[path];
  } else {
    write({id:client.id,label:client.label,file:path},original,contents,home);
    const nextHash=digest(contents);
    if(saved[path]===nextHash)return;
    saved[path]=nextHash;
  }
  mkdirSync(home,{recursive:true,mode:0o700});const temp=`${registry}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify(saved,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,registry);
}
// Codex connections made before 0.3.0 have no alert hook; setup adds it.
export function codexAlertsInstalled(client) {
  const file = join(dirname(client.file), 'hooks.json');
  return existsSync(file) && readFileSync(file, 'utf8').includes('"Clanker Chat alerts"');
}
export function installNotifications(client, launch, home, { remove=false, write } = {}) {
  if (client.id === 'omp') managedFile(join(dirname(client.file),'extensions/clanker-chat.js'),readFileSync(join(assets,'omp.js'),'utf8'),home,client,remove,write);
  if (client.id === 'hermes') for (const name of ['plugin.yaml','__init__.py']) managedFile(join(dirname(client.file),'plugins/clanker-chat',name),readFileSync(join(assets,'hermes',name),'utf8'),home,client,remove,write);
  if (client.id === 'opencode') {
    const connection = { home, id: 'opencode', token: launch.env.CLANKER_CLIENT_TOKEN };
    // Node realpaths modules into the Cellar; opt survives upgrades and cleanup.
    const modules = process.env.CLANKER_BREW_FORMULA && launch.command === process.env.CLANKER_EXECUTABLE
      ? resolve(launch.command, '../../libexec/src/integrations') : assets;
    for (const [entry, source, id] of [['index.js', 'opencode.js', 'clanker-chat'], ['tui.js', 'opencode-tui.js', 'clanker-chat.tui']]) {
      const contents = `import setup from ${JSON.stringify(pathToFileURL(join(modules, source)).href)};\nexport default { id: ${JSON.stringify(id)}, setup: context => setup(context, ${JSON.stringify(connection)}) };\n`;
      managedFile(join(dirname(client.file), 'plugins/clanker-chat', entry), contents, home, client, remove, write);
    }
    if (remove) {
      try { rmdirSync(join(dirname(client.file), 'plugins/clanker-chat')); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    }
  }
  if (client.id !== 'codex') return;
  const file=join(dirname(client.file),'hooks.json');const original=existsSync(file)?readFileSync(file,'utf8'):'';const errors=[];
  const config=parse(original||'{}',errors,{allowTrailingComma:true});
  if(errors.length||!config||Array.isArray(config)||typeof config!=='object')throw new Error('Codex hook settings could not be read. They were left unchanged.');
  const command=[launch.command,...launch.args.slice(0,-1),'notify','codex','--home',home,'--agent-home',client.agentHome||dirname(client.file),'--agent-bin',client.executable].map(quote).join(' ');
  let next=original||'{}\n';
  for(const event of ['SessionStart','SessionEnd']) {
    const groups=config.hooks?.[event]||[];
    if(!Array.isArray(groups)||groups.some(g=>!Array.isArray(g.hooks)))throw new Error('Codex has unsupported hook settings. They were left unchanged.');
    const retained=[];
    for(const group of groups){const hooks=[];for(const hook of group.hooks){if(hook.statusMessage!=='Clanker Chat alerts'){hooks.push(hook);continue;}if(hook.command!==command)throw new Error('A different Clanker Chat notification hook exists. It was left unchanged.');}if(hooks.length)retained.push({...group,hooks});}
    if(!remove)retained.push({hooks:[{type:'command',command,statusMessage:'Clanker Chat alerts',timeout:event==='SessionStart'?86400:3,...(event==='SessionStart'?{async:true}:{})}]});
    next=applyEdits(next,modify(next,['hooks',event],retained,{formattingOptions:{insertSpaces:true,tabSize:2}}));
  }
  write({id:'codex',label:'Codex hooks',file},original,next,home);
}
