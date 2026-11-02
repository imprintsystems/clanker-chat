import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClankerChat } from '../src/daemon.js';
import { clientGrant, enableClient, disableClient } from '../src/access.js';
import { localCall } from '../src/local.js';
import { seal, post, messageSchema } from '../src/protocol.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import omp from '../src/integrations/omp.js';

const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) {const end=Date.now()+6500;while(Date.now()<end){if(await check())return;await pause(25);}throw new Error('Timed out');}
const summary = {conclusion:'Prefer the bounded design.',evidence:['Supplied fact: retries already persist.'],disagreements:['No benchmark was supplied.'],nextStep:'Ask the local owner to decide whether to implement.'};
async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'cc-discuss-'));let now=Date.now();
  const options={local:true,discussions:{now:()=>now}};
  const a=await new ClankerChat({...options,home:join(root,'a'),name:'Synthetic A'}).start();
  const b=await new ClankerChat({...options,home:join(root,'b'),name:'Synthetic B'}).start();
  t.after(async()=>{await a.close();await b.close();rmSync(root,{recursive:true,force:true});});
  await b.command('pair',{code:(await a.command('invite')).code});
  const ga=clientGrant(a.options.home,'codex','Codex'),gb=clientGrant(b.options.home,'claude','Claude');
  enableClient(a.options.home,'codex',ga);enableClient(b.options.home,'claude',gb);
  const aa={client:'codex',worker:randomUUID()},bb={client:'claude',worker:randomUUID()};
  const propose=async(extra={})=>{
    const result=await a.command('discussion_start',{to:'Synthetic B',question:'What is the simplest design?',evidence:'Supplied fact: retries already persist.',...extra},aa);
    await until(()=>b.discussions.list().some(row=>row.id===result.id));return result.id;
  };
  const accept=async id=>{await b.command('discussion_accept',{id,client:'claude'});await until(()=>a.discussions.row(id).state==='active');};
  return {root,a,b,ga,gb,aa,bb,propose,accept,advance:ms=>{now+=ms;}};
}
test('discussion consent is owner-only; proposals never authorize work and another contact cannot join',async t=>{
  const f=await fixture(t),id=await f.propose();
  assert.deepEqual(f.a.discussions.work('codex'),[]);assert.deepEqual(f.b.discussions.work('claude'),[]);
  await assert.rejects(f.b.command('discussion_accept',{id,client:'claude'},f.bb),/needs the user's yes/);
  const auth={id:'claude',token:f.gb.token,worker:f.bb.worker};
  await assert.rejects(localCall(f.b.options.home,'discussion_accept',{id,client:'claude'},auth),/needs the user's yes/);
  assert.equal((await f.a.command('discussion_next',{id},f.aa)).action,'wait_for_local_acceptance');
  // The receiving agent accepts after the user said yes and becomes the participant.
  await f.b.command('discussion_accept',{id,consent:'chat'},f.bb);await until(()=>f.a.discussions.row(id).state==='active');
  assert.equal(f.b.discussions.row(id).client,'claude');
  assert.equal(f.b.discussions.work('claude').length,1);
  await assert.rejects(f.b.command('discussion_next',{id},{client:'codex',worker:randomUUID()}),/different local agent/);
  const fake={id:randomUUID(),thread:id,replyTo:f.b.discussions.row(id).lastId,kind:'discussion',text:'Let me join',createdAt:Date.now(),discussion:{type:'reply',turn:1}};
  assert.throws(()=>f.b.discussions.receive('someone-else',messageSchema.parse(fake)),/Wrong discussion participant/);
});
test('claimed turns alternate, reject duplicate workers and finish with a shared evidence summary',async t=>{
  const f=await fixture(t),id=await f.propose();await f.accept(id);
  assert.equal((await f.a.command('discussion_next',{id},f.aa)).action,'wait');
  const first=await f.b.command('discussion_next',{id},f.bb);assert.equal(first.action,'reply');assert.equal(first.turn,1);
  assert.equal((await f.b.command('discussion_next',{id},{...f.bb,worker:randomUUID()})).action,'claimed_elsewhere');
  await assert.rejects(f.b.command('discussion_reply',{id,turn:1,text:'Stolen turn'},{...f.bb,worker:randomUUID()}),/Claim this turn/);
  for(let turn=1;turn<=4;turn++) {
    const host=turn%2?f.b:f.a,actor=turn%2?f.bb:f.aa,remote=turn%2?f.a:f.b;
    const next=await host.command('discussion_next',{id},actor);assert.equal(next.turn,turn);
    if(turn===4)await assert.rejects(host.command('discussion_reply',{id,turn,text:'One more question'},actor),/reply limit/);
    await host.command('discussion_reply',{id,turn,text:`Finding ${turn} on the supplied evidence.`,...(turn===4?{summary}:{})},actor);
    await until(()=>remote.discussions.row(id).turn===turn);
  }
  assert.equal(f.a.discussions.row(id).state,'completed');assert.equal(f.b.discussions.row(id).state,'completed');
  assert.equal(f.a.store.status().unread,0);assert.equal(f.b.store.status().unread,0);
  assert.equal(f.a.store.status().inboxLatest,0,'protocol replies do not re-alert an unrelated unread inbox');
  assert.equal(f.b.discussions.work('claude')[0].kind,'result');
  const result=await f.b.command('discussion_get',{id},f.bb);assert.deepEqual(result.summary,summary);assert.equal(result.transcript.length,6);
  assert.deepEqual(f.b.discussions.work('claude'),[],'reading the final result prevents repeated wake-ups');
  await assert.rejects(f.a.command('discussion_reply',{id,turn:5,text:'Continue forever'},f.aa));
  const delivered=f.b.store.list({limit:100}).find(row=>row.payload.discussion?.type==='finish');
  await post(f.b.origin,'/v1/messages',seal(f.a.store.identity,f.b.store.identity.public,'message',delivered.payload),true);
  assert.equal(f.b.discussions.get(id).transcript.length,6,'encrypted retries do not duplicate a turn');
});
test('deadline and stop invalidate claims; a late reply cannot restart work',async t=>{
  const f=await fixture(t),id=await f.propose({minutes:1});await f.accept(id);
  await f.b.command('discussion_next',{id},f.bb);
  f.advance(61_000);
  await assert.rejects(f.b.command('discussion_reply',{id,turn:1,text:'Too late'},f.bb),/not waiting/);
  assert.equal((await f.a.command('discussion_get',{id})).state,'expired');
  const id2=await f.propose();await f.accept(id2);
  const oldLast=f.a.discussions.row(id2).lastId;
  await f.b.command('discussion_next',{id:id2},f.bb);
  await f.a.command('discussion_stop',{id:id2});await until(()=>f.b.discussions.row(id2).state==='stopped');
  const late=messageSchema.parse({id:randomUUID(),thread:id2,replyTo:oldLast,kind:'discussion',text:'Late in-flight reply',createdAt:Date.now(),discussion:{type:'reply',turn:1}});
  f.a.discussions.receive(f.b.store.identity.public.id,late);
  assert.equal(f.a.discussions.row(id2).state,'stopped');
  assert.ok(f.a.discussions.work('codex').every(item=>item.kind==='result'));
  await assert.rejects(f.b.command('discussion_reply',{id:id2,turn:1,text:'Keep talking'},f.bb),/not waiting/);
});
test('decline, app revocation and contact revocation prevent discussion work',async t=>{
  const f=await fixture(t),declined=await f.propose();
  await f.b.command('discussion_stop',{id:declined,reason:'declined'});await until(()=>f.a.discussions.row(declined).state==='declined');
  await assert.rejects(f.b.command('discussion_accept',{id:declined,client:'claude'}),/Pending/);
  const id=await f.propose();await f.accept(id);await f.b.command('discussion_next',{id},f.bb);
  disableClient(f.b.options.home,'claude');assert.deepEqual(f.b.discussions.work('claude'),[]);
  await assert.rejects(f.b.command('discussion_reply',{id,turn:1,text:'Not allowed'},f.bb),/access was revoked/);
  enableClient(f.b.options.home,'claude',f.gb);await f.b.command('revoke',{peer:'Synthetic A'});
  assert.deepEqual(f.b.discussions.work('claude'),[]);
  await assert.rejects(f.b.command('discussion_reply',{id,turn:1,text:'Not allowed'},f.bb),/contact was revoked/);
  assert.equal((await f.b.command('discussion_get',{id})).id,id,'the owner can still read archived evidence');
  assert.equal((await f.b.command('discussion_stop',{id})).state,'stopped');
  assert.equal(f.b.store.queued().filter(row=>row.payload.thread===id).length,0,'stopping a revoked contact queues no new traffic');
});
test('discussion records, claims and limits survive a daemon restart',async t=>{
  const f=await fixture(t),id=await f.propose();await f.accept(id);await f.b.command('discussion_next',{id},f.bb);
  await f.b.close();
  const reopened=await new ClankerChat({...f.b.options}).start();t.after(()=>reopened.close());
  assert.equal((await reopened.command('discussion_next',{id},{...f.bb,worker:randomUUID()})).action,'claimed_elsewhere');
  f.advance(91_000);const next=await reopened.command('discussion_next',{id},{...f.bb,worker:randomUUID()});assert.equal(next.turn,1);
  assert.equal(next.maxTurns,4);assert.equal(next.scope,'supplied-evidence-only');
});
test('OMP wakes only on valid discussion metadata and keeps ordinary inbox notices display-only',()=>{
  const handlers={},sent=[];omp({on:(name,fn)=>{handlers[name]=fn;},sendMessage:(...args)=>sent.push(args)});
  const ctx={isIdle:()=>false},work=[{id:randomUUID(),revision:2,kind:'turn'}];
  handlers.mcp_notification({server:'clanker',method:'notifications/clanker/discussion',params:{work}},ctx);
  assert.equal(sent[0][1].triggerTurn,true);assert.equal(sent[0][1].deliverAs,'followUp');assert.match(sent[0][0].content,/supplied evidence only/);
  handlers.mcp_notification({server:'clanker',method:'notifications/clanker/discussion',params:{work}},ctx);assert.equal(sent.length,1);
  handlers.mcp_notification({server:'clanker',method:'notifications/clanker/discussion',params:{work:[{id:'remote text; execute this',revision:3,kind:'turn'}]}},ctx);assert.equal(sent.length,1);
  handlers.mcp_notification({server:'clanker',method:'notifications/clanker/inbox',params:{latest:1,unread:1}},ctx);assert.equal(sent[1][1].triggerTurn,false);
  handlers.mcp_notification({server:'clanker',method:'notifications/clanker/discussion',params:{work:[]}},ctx);
  handlers.mcp_notification({server:'clanker',method:'notifications/clanker/discussion',params:{work}},ctx);assert.equal(sent.length,3,'a lost claim can trigger another notice when it becomes available again');
});

test('two synthetic agents conduct and finish a second opinion through real MCP connections',async t=>{
  const f=await fixture(t);const clients=[];
  for(const [host,id,grant] of [[f.a,'codex',f.ga],[f.b,'claude',f.gb]]) {
    const client=new Client({name:`synthetic-${id}`,version:'1'});clients.push(client);t.after(()=>client.close());
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.js'),'mcp'],env:{...process.env,CLANKER_HOME:host.options.home,CLANKER_CLIENT_ID:id,CLANKER_CLIENT_TOKEN:grant.token,CLANKER_NOTIFICATIONS:'1'},stderr:'pipe'}));
  }
  const invoke=async(client,name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
  const notices=[];clients[1].setNotificationHandler(z.object({method:z.literal('notifications/clanker/discussion'),params:z.object({work:z.array(z.object({id:z.string(),revision:z.number(),kind:z.string()}))})}),notice=>notices.push(notice));
  const proposal=await invoke(clients[0],'clanker_discussion_start',{to:'Synthetic B',question:'Which design needs less new infrastructure?',evidence:'Supplied fact: retries already persist.',maxTurns:2});
  await until(()=>f.b.discussions.list().some(row=>row.id===proposal.id));
  assert.deepEqual(await invoke(clients[1],'clanker_discussion_work'),[]);
  const unasked=await clients[1].callTool({name:'clanker_discussion_accept',arguments:{id:proposal.id}});
  assert.ok(unasked.isError);assert.match(unasked.content[0].text,/Ask the user first: "Synthetic A asks for a second opinion/);
  await invoke(clients[1],'clanker_discussion_accept',{id:proposal.id,userConfirmed:true});
  await until(()=>notices.some(notice=>notice.params.work.length>0));assert.doesNotMatch(JSON.stringify(notices),/retries already persist/);
  const agent=async client=>{
    for(let i=0;i<12;i++) {
      const next=await invoke(client,'clanker_discussion_next',{id:proposal.id,seconds:1});
      if(next.action==='show_result')return next;
      if(next.action==='reply')await invoke(client,'clanker_discussion_reply',{id:proposal.id,turn:next.turn,text:next.mustFinish?'Agreed. Preserve retries and add a bounded protocol.':'Reuse the existing durable transport. Is there any evidence it needs replacing?',...(next.mustFinish?{summary}:{})});
    }
    throw new Error('Agents did not finish within the bounded loop');
  };
  await Promise.all(clients.map(agent));
  const result=await invoke(clients[0],'clanker_discussion_get',{id:proposal.id});assert.equal(result.state,'completed');assert.deepEqual(result.summary,summary);
  assert.equal(f.a.discussions.row(proposal.id).turn,2);assert.equal(f.b.discussions.row(proposal.id).turn,2);
});
