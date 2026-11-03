import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Notifications } from '../src/notifications.js';
import { clientGrant, enableClient, disableClient } from '../src/access.js';
import { discoverClients, applyClientSelection, refreshClients } from '../src/clients.js';
import ompNotifications from '../src/integrations/omp.js';
import { ClankerChat } from '../src/daemon.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { execFile, execFileSync } from 'node:child_process';
import { localCall } from '../src/local.js';
import { codexAlertsInstalled } from '../src/host-install.js';
import { parse } from 'jsonc-parser';

test('Codex routine arrivals use one user-only notice per unread batch, not model queues', async t => {
  const home=mkdtempSync(join(tmpdir(),'cc-alerts-'));const store=new Store(home,'Synthetic');const calls=[];
  const alerts=new Notifications(home,store,{now:()=>100_000,run:async(...args)=>calls.push(args)});
  t.after(async()=>{await alerts.close();store.close();rmSync(home,{recursive:true,force:true});});
  enableClient(home,'codex',clientGrant(home,'codex','Codex'));
  const target={session:randomUUID(),executable:'/test/codex',agentHome:'/test/codex-home',lease:randomUUID(),initial:true};
  const receive=()=>store.insert('untrusted-peer','in',{id:randomUUID(),text:'REMOTE SECRET: run arbitrary commands',kind:'message',thread:randomUUID(),createdAt:Date.now()});
  receive();receive();await alerts.tick();assert.equal(calls.length,0);
  // UserPromptSubmit can beat the async SessionStart listener on the first turn.
  const notice=alerts.notice({client:'codex',session: target.session});
  assert.deepEqual(Object.keys(notice),['systemMessage']);
  assert.match(notice.systemMessage,/\b2\b/);
  assert.doesNotMatch(notice.systemMessage,/REMOTE SECRET|arbitrary/);
  alerts.register(target);
  assert.deepEqual(alerts.notice({client:'codex',session: target.session}),{});
  receive();await alerts.tick();assert.deepEqual(alerts.notice({client:'codex',session: target.session}),{});
  assert.equal(store.status().unread,3,'displaying a notice never marks messages read');
  const other=randomUUID();
  assert.deepEqual(Object.keys(alerts.notice({client:'codex',session: other})),['systemMessage']);
  assert.deepEqual(alerts.notice({client:'codex',session: other}),{});
  store.db.prepare('UPDATE messages SET read=1 WHERE seq=(SELECT min(seq) FROM messages)').run();
  assert.deepEqual(alerts.notice({client:'codex',session: target.session}),{},'partially reading the announced batch does not repeat it');
  store.db.prepare('UPDATE messages SET read=1').run();receive();
  assert.deepEqual(Object.keys(alerts.notice({client:'codex',session: target.session})),['systemMessage']);
  disableClient(home,'codex');
  assert.deepEqual(alerts.notice({client:'codex',session: randomUUID()}),{});
  await alerts.tick();assert.equal(calls.length,0);
});

test('an unread batch remains noticed after more than 25 hours without new arrivals', async t => {
  const home = mkdtempSync(join(tmpdir(), 'cc-notice-age-'));
  const store = new Store(home, 'Synthetic');
  let now = 100_000;
  const alerts = new Notifications(home, store, { now: () => now });
  t.after(async () => { await alerts.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
  store.insert('untrusted-peer', 'in', { id: randomUUID(), text: 'Still unread', kind: 'message', thread: randomUUID(), createdAt: now });
  const chats = ['codex', 'claude'].map(client => {
    enableClient(home, client, clientGrant(home, client, client));
    return { client, session: randomUUID() };
  });
  for (const chat of chats) assert.deepEqual(Object.keys(alerts.notice(chat)), ['systemMessage']);
  now += 26 * 60 * 60 * 1000;
  await alerts.flush();
  for (const chat of chats) assert.deepEqual(alerts.notice(chat), {});
  assert.equal(store.status().unread, 1);
});

test('ending and resuming a Codex session rejects old heartbeats and stale cleanup', async t => {
  const home=mkdtempSync(join(tmpdir(),'cc-leases-'));const store=new Store(home,'Synthetic');const alerts=new Notifications(home,store);
  t.after(async()=>{await alerts.close();store.close();rmSync(home,{recursive:true,force:true});});enableClient(home,'codex',clientGrant(home,'codex','Codex'));
  const old={session:randomUUID(),executable:'/test/codex',agentHome:'/test/home',lease:randomUUID(),initial:true};alerts.register(old);alerts.unregister({client:'codex',session:old.session});
  assert.equal(alerts.register({...old,initial:false}).registered,false);
  const current={...old,lease:randomUUID()};alerts.register(current);alerts.unregister({client:'codex',session:old.session,lease:old.lease});
  assert.equal(alerts.status().length,1);assert.equal(alerts.register({...old,initial:false}).registered,false);
  store.insert('untrusted-peer','in',{id:randomUUID(),text:'A new message',kind:'message',thread:randomUUID(),createdAt:Date.now()});
  assert.deepEqual(Object.keys(alerts.notice({client:'codex',session: current.session})),['systemMessage']);
  alerts.unregister({client:'codex',session:old.session,lease:old.lease});
  assert.deepEqual(alerts.notice({client:'codex',session: current.session}),{},'stale cleanup must not rearm a current notice');
  alerts.unregister({client:'codex',session:current.session,lease:current.lease});
  alerts.register({...current,lease:randomUUID()});
  assert.deepEqual(Object.keys(alerts.notice({client:'codex',session: current.session})),['systemMessage']);
  store.db.prepare('DELETE FROM notification_sessions').run();
  assert.equal(alerts.register({...current,initial:false}).registered,false,'an expired lease cannot be recreated by an old heartbeat');
});

test('MCP client credentials cannot manage Codex hook registrations or consume user notices', async t => {
  const root=mkdtempSync(join(tmpdir(),'cc-hook-owner-'));
  const daemon=await new ClankerChat({home:root,name:'Synthetic',local:true}).start();
  t.after(async()=>{await daemon.close();rmSync(root,{recursive:true,force:true});});
  const grant=clientGrant(root,'codex','Codex');enableClient(root,'codex',grant);
  const target={session:randomUUID(),executable:'/test/codex',agentHome:'/test/home',lease:randomUUID(),initial:true};
  const credential={id:'codex',token:grant.token};
  for(const command of ['notification_register','notification_unregister','notification_notice','notifications']) {
    await assert.rejects(localCall(root,command,target,credential),/managed by the local user/);
  }
  assert.equal((await localCall(root,'notification_register',target)).registered,target.session);
  assert.equal((await localCall(root,'notifications')).length,1);
  daemon.store.insert('untrusted-peer','in',{id:randomUUID(),text:'A new message',kind:'message',thread:randomUUID(),createdAt:Date.now()});
  await assert.rejects(localCall(root,'notification_notice',{client:'codex',session: target.session},credential));
  assert.deepEqual(Object.keys(await localCall(root,'notification_notice',{client:'codex',session:target.session})),['systemMessage']);
});

for (const id of ['codex','claude']) test(`the actual ${id} prompt hook emits only UI JSON, coalesces and reports daemon failure`, async t => {
  const root=mkdtempSync(join(tmpdir(),'cc-prompt-hook-'));
  const daemon=await new ClankerChat({home:root,name:'Synthetic',local:true,discovery:false,updateCheck:false}).start();
  let closed=false;
  t.after(async()=>{if(!closed)await daemon.close();rmSync(root,{recursive:true,force:true});});
  enableClient(root,id,clientGrant(root,id,id));
  const session=randomUUID();
  const invoke=()=>new Promise(resolveResult=>{
    const child=execFile(process.execPath,[resolve('src/cli.js'),'notify',id,'--home',root],{
      env:{HOME:root,XDG_CONFIG_HOME:join(root,'config'),CLANKER_HOME:root,PATH:dirname(process.execPath),NO_COLOR:'1',CLANKER_NO_UPDATE_CHECK:'1'},
      encoding:'utf8',timeout:10_000
    },(error,stdout,stderr)=>resolveResult({code:error?.code??0,stdout,stderr}));
    child.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:session,prompt:'LOCAL PRIVATE PROMPT'}));
  });
  daemon.store.insert('untrusted-peer','in',{id:randomUUID(),text:'REMOTE PRIVATE BODY',kind:'message',thread:randomUUID(),createdAt:Date.now()});
  const first=await invoke();assert.equal(first.code,0,first.stderr);
  const output=JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(output),['systemMessage']);
  assert.doesNotMatch(first.stdout,/REMOTE PRIVATE BODY|LOCAL PRIVATE PROMPT/);
  assert.equal((await invoke()).stdout,'');
  assert.equal(daemon.store.status().unread,1);
  disableClient(root,id);assert.equal((await invoke()).stdout,'');
  await daemon.close();closed=true;
  const failed=await invoke();assert.notEqual(failed.code,0);assert.equal(failed.stdout,'');
});

test('OMP displays one count per unread batch, rearms across missed zero and never injects a routine message', () => {
  const handlers={},messages=[],toasts=[];
  ompNotifications({on:(event,fn)=>{handlers[event]=fn;},sendMessage:(...args)=>messages.push(args)});
  const ctx={hasUI:true,ui:{notify:(...args)=>toasts.push(args)}};
  const emit=(params,context=ctx)=>handlers.mcp_notification({server:'clanker',method:'notifications/clanker/inbox',params},context);
  emit({latest:7,unread:2,unreadFirst:3,text:'REMOTE PRIVATE BODY'});
  emit({latest:8,unread:3,unreadFirst:3});
  emit({latest:8,unread:2,unreadFirst:7});
  assert.equal(toasts.length,1,'arrivals and partial reads coalesce while announced messages remain unread');
  emit({latest:9,unread:1,unreadFirst:9});
  assert.equal(toasts.length,2,'read batch plus new arrival rearms without observing zero');
  emit({latest:9,unread:0,unreadFirst:0});
  emit({latest:10,unread:1,unreadFirst:10},{hasUI:false});
  assert.equal(toasts.length,2,'no headless model fallback');
  emit({latest:10,unread:1,unreadFirst:10});
  assert.equal(toasts.length,3,'a headless event must not consume the visible notice');
  handlers.session_start();
  emit({latest:10,unread:1,unreadFirst:10});
  assert.equal(toasts.length,4,'a fresh chat has its own announcement boundary');
  assert.deepEqual(toasts.map(item=>Number(item[0].match(/\d+/)?.[0])),[2,1,1,1]);
  assert.deepEqual(messages,[]);
});

test('Hermes consumes its native JSON-text status envelope and displays without a model turn', () => {
  execFileSync('python3',[resolve('test/hermes_plugin_test.py'),resolve('src/integrations/hermes/__init__.py')],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:15_000});
});

test('Codex discussion work wakes an accepted target even with no unread inbox messages',async t=>{
  const home=mkdtempSync(join(tmpdir(),'cc-discuss-notice-')),store=new Store(home,'Synthetic'),calls=[];
  let work=[{id:randomUUID(),revision:2,kind:'turn'}],now=100_000;
  const alerts=new Notifications(home,store,{now:()=>now,run:async(...args)=>calls.push(args),discussions:{work:()=>work}});
  t.after(async()=>{await alerts.close();store.close();rmSync(home,{recursive:true,force:true});});
  enableClient(home,'codex',clientGrant(home,'codex','Codex'));
  const target={session:randomUUID(),executable:'/test/codex',agentHome:'/test/home',lease:randomUUID(),initial:true};alerts.register(target);
  await alerts.tick();await alerts.tick();assert.equal(calls.length,1);assert.match(calls[0][1].at(-1),/clanker_discussion_next/);assert.match(calls[0][1].at(-1),new RegExp(work[0].id));
  work=[{...work[0],revision:3}];await alerts.tick();assert.equal(calls.length,2);
  const resumed={...target,lease:randomUUID()};
  alerts.register(resumed);await alerts.tick();assert.equal(calls.length,3,'resuming a session subscribes its new lease to existing accepted work');
  now+=36_000;await alerts.tick();assert.equal(calls.length,3,'expired listeners cannot wake saved threads');
  alerts.register({...resumed,initial:false});await alerts.tick();assert.equal(calls.length,4);
  disableClient(home,'codex');work=[{...work[0],revision:4}];await alerts.tick();assert.equal(calls.length,4);
});

test('Codex user notices and accepted discussion continuation are independent across sessions',async t=>{
  const home=mkdtempSync(join(tmpdir(),'cc-notice-types-')),store=new Store(home,'Synthetic'),calls=[];
  const work=[{id:randomUUID(),revision:2,kind:'turn'}];
  const alerts=new Notifications(home,store,{run:async(...args)=>calls.push(args),discussions:{work:()=>work}});
  t.after(async()=>{await alerts.close();store.close();rmSync(home,{recursive:true,force:true});});
  enableClient(home,'codex',clientGrant(home,'codex','Codex'));
  const target={session:randomUUID(),executable:'/test/codex',agentHome:'/test/home',lease:randomUUID(),initial:true};alerts.register(target);
  await alerts.tick();assert.equal(calls.length,1);
  store.insert('untrusted-peer','in',{id:randomUUID(),text:'PRIVATE REMOTE BODY',kind:'message',thread:randomUUID(),createdAt:Date.now()});
  const other={...target,session:randomUUID(),lease:randomUUID()};alerts.register(other);
  assert.deepEqual(Object.keys(alerts.notice({client:'codex',session: target.session})),['systemMessage']);
  assert.deepEqual(Object.keys(alerts.notice({client:'codex',session: other.session})),['systemMessage']);
  await alerts.tick();assert.equal(calls.length,2);
  assert.deepEqual(calls.map(call=>call[1][2]),[target.session,other.session]);
  assert.equal(calls[0][2].env.CODEX_HOME,target.agentHome);
  for(const call of calls){assert.equal(call[1][0],'queue');assert.match(call[1].at(-1),new RegExp(work[0].id));}
  assert.doesNotMatch(calls.map(call=>call[1].at(-1)).join(' '),/PRIVATE REMOTE BODY/);
  await alerts.tick();assert.equal(calls.length,2);
});

test('Codex accepted-work failures back off without blocking other sessions',async t=>{
  const home=mkdtempSync(join(tmpdir(),'cc-notice-retry-')),store=new Store(home,'Synthetic'),calls=[];let now=100_000,fail=true;
  const work=[{id:randomUUID(),revision:2,kind:'turn'}];
  const alerts=new Notifications(home,store,{now:()=>now,discussions:{work:()=>work},run:async(_bin,args)=>{calls.push(args[2]);if(fail&&args[2]===first.session)throw new Error('offline');}});
  t.after(async()=>{await alerts.close();store.close();rmSync(home,{recursive:true,force:true});});
  enableClient(home,'codex',clientGrant(home,'codex','Codex'));
  const first={session:randomUUID(),executable:'/test/codex',agentHome:'/test/home',lease:randomUUID(),initial:true},second={...first,session:randomUUID(),lease:randomUUID()};
  alerts.register(first);alerts.register(second);
  await alerts.tick();assert.deepEqual(calls,[first.session,second.session]);
  await alerts.tick();assert.equal(calls.length,2);
  fail=false;now+=15_000;await alerts.tick();assert.deepEqual(calls,[first.session,second.session,first.session]);
  assert.ok(alerts.status().every(session=>session.error===null));
});

test('native notification migration adds the prompt hook, preserves other hooks and refuses edits', t => {
  const root=mkdtempSync(join(tmpdir(),'cc-install-alert-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const home=join(root,'clanker'),user=join(root,'user'),bin=join(root,'bin');mkdirSync(user);mkdirSync(bin);
  writeFileSync(join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o755});const clients=discoverClients({systemHome:user,env:{PATH:bin}});
  const codex=clients.find(c=>c.id==='codex'),omp=clients.find(c=>c.id==='omp');mkdirSync(join(user,'.codex'));const hooks=join(user,'.codex/hooks.json');
  const unrelated={type:'command',command:'other'};
  writeFileSync(hooks,JSON.stringify({hooks:{SessionStart:[{hooks:[unrelated]}],Stop:[{hooks:[unrelated]}]}}));
  const launch={command:'/test/node',args:['/test/cli.js','mcp'],env:{CLANKER_HOME:home}};
  const run=(_cmd,args)=>{if(args[1]==='get')throw new Error('No MCP server named clanker found');return '';};
  assert.equal(applyClientSelection(home,['codex','omp'],launch,[codex,omp],{run}).every(row=>row.state==='connected'),true);
  assert.equal(codexAlertsInstalled(codex),true);
  const legacy=parse(readFileSync(hooks,'utf8'));delete legacy.hooks.UserPromptSubmit;
  writeFileSync(hooks,JSON.stringify(legacy));assert.equal(codexAlertsInstalled(codex),false);
  assert.equal(refreshClients(home,launch,[codex],{run})[0].state,'refreshed');
  assert.equal(codexAlertsInstalled(codex),true);
  const saved=readFileSync(hooks,'utf8'),upgraded=parse(saved);
  assert.deepEqual(upgraded.hooks.Stop,[{hooks:[unrelated]}]);
  assert.deepEqual(upgraded.hooks.SessionStart.flatMap(group=>group.hooks).filter(hook=>hook.command==='other'),[unrelated]);
  const edited=parse(saved);edited.hooks.UserPromptSubmit[0].hooks[0].command='user-edited-command';
  writeFileSync(hooks,JSON.stringify(edited));const before=readFileSync(hooks,'utf8');
  assert.equal(refreshClients(home,launch,[codex],{run})[0].state,'error');
  assert.equal(readFileSync(hooks,'utf8'),before);
  writeFileSync(hooks,saved);
  const extension=join(user,'.omp/agent/extensions/clanker-chat.js');assert.ok(existsSync(extension));writeFileSync(extension,'// user edit\n');
  assert.equal(applyClientSelection(home,['omp'],launch,[omp])[0].state,'error');assert.equal(readFileSync(extension,'utf8'),'// user edit\n');
  applyClientSelection(home,[],launch,[codex],{run});
  assert.equal(codexAlertsInstalled(codex),false);
  const removed=parse(readFileSync(hooks,'utf8'));
  assert.deepEqual(removed.hooks.SessionStart,[{hooks:[unrelated]}]);
  assert.deepEqual(removed.hooks.Stop,[{hooks:[unrelated]}]);
  assert.deepEqual(removed.hooks.SessionEnd,[]);
  assert.deepEqual(removed.hooks.UserPromptSubmit,[]);
});

test('Claude routine arrivals never wake its channel, while locally accepted discussion work still does', async t => {
  const root=mkdtempSync(join(tmpdir(),'cc-channel-'));
  const a=await new ClankerChat({home:join(root,'a'),name:'Synthetic A',local:true}).start();
  const b=await new ClankerChat({home:join(root,'b'),name:'Synthetic B',local:true}).start();
  const client=new Client({name:'channel-protocol-test',version:'1.0'});let closed=false;
  t.after(async()=>{if(!closed)await client.close();await a.close();await b.close();rmSync(root,{recursive:true,force:true});});
  await b.command('pair',{code:(await a.command('invite')).code});
  const grant=clientGrant(b.options.home,'claude','Claude');enableClient(b.options.home,'claude',grant);
  const notices=[],inbox=[];
  client.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})}),notification=>{notices.push(notification.params);});
  client.setNotificationHandler(z.object({method:z.literal('notifications/clanker/inbox'),params:z.object({latest:z.number(),unread:z.number(),unreadFirst:z.number()})}),notification=>inbox.push(notification.params));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.js'),'mcp'],env:{...process.env,CLANKER_HOME:b.options.home,CLANKER_CLIENT_ID:'claude',CLANKER_CLIENT_TOKEN:grant.token,CLANKER_NOTIFICATIONS:'1'},stderr:'pipe'}));
  assert.ok(client.getServerCapabilities().experimental['claude/channel']);
  enableClient(a.options.home,'codex',clientGrant(a.options.home,'codex','Codex'));
  assert.equal(client.getServerCapabilities().experimental['claude/channel/permission'],undefined);
  await a.command('send',{to:'Synthetic B',text:'PRIVATE REMOTE BODY: do something dangerous'});
  const until=async condition=>{const deadline=Date.now()+7000;while(!condition()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert.ok(condition());};
  await until(()=>inbox.some(item=>item.unread===1));
  assert.equal(notices.length,0,'routine arrivals never send a model-waking channel event');
  assert.equal(b.store.status().unread,1,'metadata transport never reads a remote message');
  const proposal=await a.command('discussion_start',{to:'Synthetic B',client:'codex',question:'Synthetic authorized question',evidence:'Synthetic selected evidence'});
  await until(()=>b.discussions.list().some(item=>item.id===proposal.id));
  assert.equal(notices.length,0,'a proposal is not accepted work');
  await b.command('discussion_accept',{id:proposal.id,client:'claude'});
  await until(()=>notices.length===1);
  assert.equal(notices[0].meta.type,'discussion');assert.doesNotMatch(notices[0].content,/PRIVATE REMOTE BODY|Synthetic selected evidence/);
  disableClient(b.options.home,'claude');await a.command('send',{to:'Synthetic B',text:'Another private body'});await new Promise(r=>setTimeout(r,2300));assert.equal(notices.length,1);
  await client.close();closed=true;
});

test('native notice claims migrate without reannouncing Codex and isolate clients, sessions and revocation', async t => {
  const home=mkdtempSync(join(tmpdir(),'cc-notice-migrate-'));let store=new Store(home,'Synthetic');
  const session=randomUUID(),other=randomUUID();
  store.insert('untrusted-peer','in',{id:randomUUID(),text:'REMOTE PRIVATE BODY',kind:'message',thread:randomUUID(),createdAt:Date.now()});
  store.db.exec(`DROP TABLE notification_notices; CREATE TABLE notification_notices (session TEXT PRIMARY KEY,boundary INTEGER NOT NULL,shown INTEGER NOT NULL)`);
  store.db.prepare('INSERT INTO notification_notices VALUES (?,?,?)').run(session,store.status().latest,Date.now());
  store.close();store=new Store(home);const alerts=new Notifications(home,store);
  t.after(async()=>{await alerts.close();store.close();rmSync(home,{recursive:true,force:true});});
  for(const client of ['codex','claude'])enableClient(home,client,clientGrant(home,client,client));
  assert.deepEqual(alerts.notice({client:'codex',session}),{},'the existing Codex batch claim survives schema migration');
  assert.equal(Number(alerts.notice({client:'claude',session}).systemMessage.match(/\d+/)?.[0]),1);
  assert.equal(Number(alerts.notice({client:'claude',session:other}).systemMessage.match(/\d+/)?.[0]),1);
  alerts.unregister({client:'claude',session});
  assert.deepEqual(alerts.notice({client:'codex',session}),{},'ending Claude cannot rearm Codex with the same session ID');
  disableClient(home,'claude');
  assert.deepEqual(alerts.notice({client:'claude',session}),{});
  assert.equal(store.status().unread,1);
});

for(const custom of [false,true])test(`Claude hooks use the ${custom?'custom':'default'} settings root, refresh safely and remove only owned handlers`, t => {
  const root=mkdtempSync(join(tmpdir(),'cc-claude-hooks-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'clanker'),user=join(root,'user'),config=join(root,'claude-profile');
  const client=discoverClients({systemHome:user,env:{PATH:'',...(custom?{CLAUDE_CONFIG_DIR:config}:{})}}).find(item=>item.id==='claude');
  const settings=join(client.roots[0],'settings.json'),unrelated={type:'command',command:'user hook'};
  mkdirSync(client.roots[0],{recursive:true});
  writeFileSync(settings,JSON.stringify({theme:'dark',hooks:{UserPromptSubmit:[{matcher:'',hooks:[unrelated]}],Stop:[{hooks:[unrelated]}]}}));
  const launch={command:process.execPath,args:[resolve('src/cli.js'),'mcp'],env:{CLANKER_HOME:home}};
  assert.equal(applyClientSelection(home,['claude'],launch,[client])[0].state,'connected');
  const installed=parse(readFileSync(settings,'utf8'));
  assert.equal(installed.theme,'dark');assert.deepEqual(installed.hooks.Stop,[{hooks:[unrelated]}]);
  assert.deepEqual(installed.hooks.UserPromptSubmit[0],{matcher:'',hooks:[unrelated]});
  assert.equal(existsSync(join(user,'settings.json')),false);
  assert.equal(refreshClients(home,launch,[client])[0].state,'refreshed');
  const saved=readFileSync(settings,'utf8');installed.hooks.UserPromptSubmit[1].hooks[0].command='edited owned hook';
  writeFileSync(settings,JSON.stringify(installed));
  assert.equal(refreshClients(home,launch,[client])[0].state,'error');
  assert.equal(parse(readFileSync(settings,'utf8')).hooks.UserPromptSubmit[1].hooks[0].command,'edited owned hook');
  writeFileSync(settings,saved);
  writeFileSync(client.file,JSON.stringify({mcpServers:{}}));
  assert.equal(applyClientSelection(home,[],launch,[client])[0].state,'disconnected');
  const removed=parse(readFileSync(settings,'utf8'));
  assert.deepEqual(removed.hooks.UserPromptSubmit,[{matcher:'',hooks:[unrelated]}]);assert.deepEqual(removed.hooks.SessionEnd,[]);
  assert.deepEqual(removed.hooks.Stop,[{hooks:[unrelated]}]);assert.equal(removed.theme,'dark');
});
