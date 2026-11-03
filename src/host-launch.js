import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { findExecutable } from './clients.js';
import { localCall, readJSON } from './local.js';

export async function runNotificationHook(home, client, { agentHome, executable }) {
  const input=await readJSON(process.stdin);
  if(input.hook_event_name==='SessionEnd') { await localCall(home,'notification_unregister',{client,session:input.session_id}); return; }
  if(input.hook_event_name==='UserPromptSubmit') {
    const notice=await localCall(home,'notification_notice',{client,session:input.session_id});
    if(notice.systemMessage) {
      const { additionalContext, ...display } = notice;
      process.stdout.write(JSON.stringify({ ...display, ...(additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : {}) })+'\n');
    }
    return;
  }
  if(client!=='codex' || input.hook_event_name!=='SessionStart') return;
  const signal=new AbortController(); const parent=process.ppid; const lease=randomUUID();
  const stop=()=>signal.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let initial=true;
  try {
    while(!signal.signal.aborted && process.ppid===parent && process.ppid!==1) {
      try { const result=await localCall(home,'notification_register',{session:input.session_id,executable,agentHome,lease,initial}); if(result.registered===false)break;initial=false; }
      catch { /* The daemon may restart during an upgrade. Keep the session subscription. */ }
      try {await pause(10_000,null,{signal:signal.signal});}catch{break;}
    }
  } finally {
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    try {await localCall(home,'notification_unregister',{client,session:input.session_id,lease});}catch{}
  }
}

export async function launchAgent(id, args, { env=process.env } = {}) {
  if(!['codex','claude','hermes','omp'].includes(id))throw new Error('Choose codex, claude, hermes or omp.');
  const executable=findExecutable(id,env.PATH);
  if(!executable)throw new Error(`${id} is not installed or is not on PATH.`);
  // This flag opts in only this explicitly selected channel; it does not bypass
  // tool permissions or enable the separate remote-approval relay capability.
  const development=args.includes('--development-channel');
  const extra=id==='claude'&&development?['--dangerously-load-development-channels','server:clanker']:id==='hermes'?['--tui']:[];
  args=args.filter(arg=>arg!=='--development-channel');
  const child=spawn(executable,[...extra,...args],{stdio:'inherit',env});
  const forward=()=>child.kill('SIGTERM');process.once('SIGTERM',forward);
  try {return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});}
  finally {process.off('SIGTERM',forward);}
}
