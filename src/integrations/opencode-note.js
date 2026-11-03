import { createHash } from 'node:crypto';
import { localCall } from '../local.js';

// Rpc.define returns this portable definition unchanged; keep the integration
// dependency-free so the installed host supplies the V2 RPC implementation.
export const inboxNoteRpc = {
  id: 'clanker-chat.inbox-note',
  methods: { displayed: {
    input: { type: 'object', properties: { boundary: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, connection: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['boundary', 'connection'], additionalProperties: false },
    output: { type: 'object', additionalProperties: false },
  } },
  events: {},
};

// Never send the managed credential over the host RPC. A fingerprint prevents a
// remote server wired to a different inbox from interpreting a local boundary.
export const noteConnectionKey = connection => createHash('sha256').update(connection?.token || '').digest('hex');

const injectedPrefixes = [
  // Our injected notices: discussions.js::discussionNotice and opencode-tui.js.
  'Clanker Chat local discussion ', 'Clanker Chat · ',
  // V2 admits this native child prompt (parentID is checked independently):
  // https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/tool/plugin/subagent.ts
  'You are a subagent spawned by another session.',
];
// This is practical owner-input filtering, not human authentication. V2 expands
// owner-invoked prompt commands before admission without retaining slash/source
// metadata; those expanded prompts follow the normal owner path.

export function ownerPrompt(text, metadata) {
  if (metadata?.source && metadata.source !== 'user') return false;
  if (typeof text !== 'string') return false;
  const value = text.trimStart();
  return Boolean(value.trim()) && !value.startsWith('/') && !value.startsWith('!')
    && !injectedPrefixes.some(prefix => value.startsWith(prefix));
}

export async function setupInboxNote(ctx, connection) {
  let pending = 0, displayed = 0, noted = 0, stopped = false;
  const turns = new Map();
  const key = noteConnectionKey(connection);
  const registration = await ctx.rpc.register(inboxNoteRpc, {
    displayed: input => {
      if (stopped || input.connection !== key || !Number.isSafeInteger(input.boundary) || input.boundary < 0) return {};
      if (!input.boundary) pending = 0;
      else if (input.boundary > displayed) pending = displayed = input.boundary;
      return {};
    },
  });
  await ctx.session.hook('prompt', async event => {
    // Capture the displayed boundary at ingress, never during a continuation.
    const boundary = pending;
    if (stopped || !ownerPrompt(event.prompt?.text, event.metadata)) return;
    const turnKey = `${event.sessionID}:${event.messageID}`;
    if (turns.has(turnKey)) return;
    // Reserve before the asynchronous lookup: concurrent admission retries share
    // an ID, but OpenCode may run their prompt hooks more than once.
    const turn = { boundary, consumed: false };
    turns.set(turnKey, turn);
    if (turns.size > 512) turns.delete(turns.keys().next().value);
    try {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.parentID || session.location.directory !== ctx.location.directory) turns.delete(turnKey);
    } catch { turns.delete(turnKey); }
  });
  await ctx.session.hook('context', async event => {
    if (stopped || !Array.isArray(event.messages)) return;
    // V2 preserves the admitted message ID when lowering stored user input to
    // model messages. Synthetic/shell/skill messages can also have role=user,
    // but never gain a matching eligible admission here.
    const last = event.messages.at(-1);
    if (last?.role !== 'user' || typeof last.id !== 'string') return;
    const turn = turns.get(`${event.sessionID}:${last.id}`);
    if (!turn || turn.consumed) return;
    turn.consumed = true;
    if (!turn.boundary || turn.boundary <= noted) return;
    // Reserve the batch even when the setting is off or the inbox is offline.
    // A later owner turn must not resurrect the same displayed batch.
    noted = turn.boundary;
    try {
      const brief = await localCall(connection.home, 'notification_context', { boundary: turn.boundary }, connection, { timeout: 500 });
      const text = brief?.additionalContext;
      if (stopped || typeof text !== 'string' || !text.trim()) return;
      event.system.push({ type: 'text', text });
    } catch { /* The owner's request never depends on inbox availability. */ }
  });
  return () => { stopped = true; turns.clear(); void registration.dispose().catch(() => {}); };
}
