import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    if (original && (saved[path] === digest(original) || original === contents)) unlinkSync(path);
    delete saved[path];
  } else {
    write({id:client.id,label:client.label,file:path},original,contents,home);
    saved[path]=digest(contents);
  }
  mkdirSync(home,{recursive:true,mode:0o700});const temp=`${registry}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify(saved,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,registry);
}
export function installNotifications(client, launch, home, { remove=false, write } = {}) {
  if (client.id === 'omp') managedFile(join(dirname(client.file),'extensions/clanker-chat.js'),readFileSync(join(assets,'omp.js'),'utf8'),home,client,remove,write);
  if (client.id === 'hermes') for (const name of ['plugin.yaml','__init__.py']) managedFile(join(dirname(client.file),'plugins/clanker-chat',name),readFileSync(join(assets,'hermes',name),'utf8'),home,client,remove,write);
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
