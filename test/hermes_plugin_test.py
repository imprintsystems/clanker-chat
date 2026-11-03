"""Exercise the plugin against Hermes' JSON-text envelope without a model/provider."""
import importlib.util
import json
import re
import sys
import threading
import types
import copy
from pathlib import Path
import socket
import tempfile
import time
from unittest.mock import patch

# The host runtime is not a test dependency; only notification behavior is under test.
sys.modules['toolsets'] = types.SimpleNamespace(create_custom_toolset=lambda *args, **kwargs: None)

spec = importlib.util.spec_from_file_location('clanker_plugin', sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

# Run the actual watcher deterministically through a bounded number of polls.
poll_budget = 0


class PollEvent:
    def __init__(self):
        self.polls = 0
        self.stopped = False

    def wait(self, _timeout=None):
        if self.stopped or self.polls >= poll_budget:
            return True
        self.polls += 1
        return False
    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True


class InlineThread:
    def __init__(self, target, **_kwargs):
        self.target = target

    def start(self):
        self.target()


plugin.threading = types.SimpleNamespace(Event=PollEvent, Thread=InlineThread, Lock=threading.Lock, Timer=threading.Timer)


class Context:
    def __init__(self, statuses=None):
        self.hooks, self.commands, self.posts = {}, {}, []
        self.done = threading.Event()
        self.calls = 0
        self.statuses = list(statuses or [{'latest': 5, 'unread': 1, 'unreadFirst': 5, 'private': 'REMOTE SECRET'}])

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_command(self, name, handler, **_):
        self.commands[name] = handler

    def on_unload(self, callback):
        self.cleanup = callback

    def call_mcp(self, server, tool, args, **_):
        assert server == 'clanker'
        if tool == 'clanker_discussion_work':
            return {'ok': True, 'result': '[]'}
        assert tool == 'clanker_status'
        self.calls += 1
        status = self.statuses[min(self.calls - 1, len(self.statuses) - 1)]
        return {'ok': True, 'result': json.dumps(status)}

    def post_message(self, text):
        assert 'REMOTE SECRET' not in text
        self.posts.append(text)
        self.done.set()
        return type('Posted', (), {'ok': True})()

    def inject_message(self, *_, **__):
        raise AssertionError('A routine notice must not start a model turn')


statuses = [
    {'latest': 5, 'unread': 2, 'unreadFirst': 4, 'private': 'REMOTE SECRET'},
    {'latest': 5, 'unread': 2, 'unreadFirst': 4},
    {'latest': 6, 'unread': 2, 'unreadFirst': 4},
    {'latest': 7, 'unread': 1, 'unreadFirst': 7},
    {'latest': 7, 'unread': 0, 'unreadFirst': 0},
    {'latest': 8, 'unread': 1, 'unreadFirst': 8},
]
poll_budget = len(statuses)
ctx = Context(statuses)
plugin.register(ctx)
assert 'pre_llm_call' in ctx.hooks
try:
    ctx.hooks['on_session_start'](session_id='test-session')
    counts = [int(re.findall(r'\d+', post)[0]) for post in ctx.posts]
    assert counts == [2, 1, 1], 'Unread boundary, rearm, or count failed'
    assert all('REMOTE SECRET' not in post for post in ctx.posts)
finally:
    ctx.cleanup()
assert not ctx.hooks['on_session_start'](session_id=''), 'An unbound session must not arm notifications'
remote = Context()
remote.session_surface = lambda: 'telegram'
plugin.register(remote)
remote.hooks['on_session_start'](session_id='not-a-local-chat')
assert remote.calls == 0 and not remote.posts
remote.cleanup()
print('Hermes status boundaries, count-only display, non-injection and cleanup passed')


class RevokedContext(Context):
    def call_mcp(self, server, tool, args, **_):
        self.calls += 1
        return {'ok': False, 'error': 'App access revoked'}


revoked = RevokedContext()
plugin.register(revoked)
try:
    revoked.hooks['on_session_start'](session_id='revoked-session')
    assert revoked.calls > 0 and not revoked.posts, 'Revoked access must not display stale inbox data'
    assert 'pre_llm_call' in revoked.hooks
finally:
    revoked.cleanup()


class DiscussionContext(Context):
    def __init__(self):
        super().__init__()
        self.injections = []

    def call_mcp(self, server, tool, args, **_):
        if tool == 'clanker_discussion_work':
            return {'ok': True, 'result': json.dumps([{'id': '00000000-0000-4000-8000-000000000001', 'revision': 2, 'kind': 'turn', 'text': 'REMOTE SECRET'}])}
        return {'ok': True, 'result': '{"latest":0,"unread":0,"unreadFirst":0}'}

    def inject_message(self, text, session_key):
        assert 'REMOTE SECRET' not in text and 'clanker_discussion_next' in text
        assert session_key == 'discussion-session'
        self.injections.append(text)
        self.done.set()
        return True


discussion = DiscussionContext()
poll_budget = 3
plugin.register(discussion)
try:
    discussion.hooks['on_session_start'](session_id='discussion-session')
    assert len(discussion.injections) == 1, 'Accepted discussion was not injected exactly once'
finally:
    discussion.cleanup()
print('Hermes accepted-discussion injection contains metadata only and is deduplicated')



# Native hooks receive the original prompt and history as DIRECT kwargs, not
# the shell hook's stdin {"extra": ...} envelope. Only user-role count is stable
# across retries that assign a new native turn_id.
def owner(ctx, count=1, text='Please answer my question.', **kwargs):
    history = [{'role': 'user', 'content': text} for _ in range(count)]
    history.extend([{'role': 'assistant', 'content': 'working'}, {'role': 'tool', 'content': 'result'}])
    payload = dict(session_id='owner-session', user_message=text, conversation_history=history,
                   platform='cli', turn_id='unstable-host-id')
    payload.update(kwargs)
    original = copy.deepcopy(payload)
    result = ctx.hooks['pre_llm_call'](**payload)
    assert payload == original, 'The plugin must not modify the owner prompt or history'
    assert result is None or set(result) == {'context'}, 'Native API expects context, not shell/additionalContext output'
    return result


class ScheduledEvent(PollEvent):
    actions = {}

    def wait(self, timeout=None):
        action = self.actions.pop(self.polls, None)
        if action:
            action()
        return super().wait(timeout)


def scheduled(statuses, actions, context=None):
    global poll_budget
    poll_budget = len(statuses)
    context = context or Context(statuses)
    ScheduledEvent.actions = actions(context)
    plugin.threading.Event = ScheduledEvent
    try:
        plugin.register(context)
        context.hooks['on_session_start'](session_id='owner-session', platform='cli')
    finally:
        plugin.threading.Event = PollEvent
    return context


batch5 = {'latest': 5, 'unread': 1, 'unreadFirst': 5}
batch6_same = {'latest': 6, 'unread': 2, 'unreadFirst': 5}
batch7 = {'latest': 7, 'unread': 1, 'unreadFirst': 7}
note_calls = []
results = []


def fetch_note(boundary):
    note_calls.append(boundary)
    return {'additionalContext': f'QUOTED NOTE {boundary}'}


with patch.object(plugin, '_notification_context', fetch_note):
    ctx = scheduled([batch5, batch6_same, batch7, batch7], lambda ctx: {
        1: lambda: results.append(owner(ctx, 1)),
        2: lambda: results.append(owner(ctx, 1, turn_id='retry-id')),
        3: lambda: results.append(owner(ctx, 1, turn_id='tool-continuation')),
        4: lambda: results.append(owner(ctx, 2)),
    })
    assert results == [{'context': 'QUOTED NOTE 5'}, None, None, {'context': 'QUOTED NOTE 7'}]
    assert note_calls == [5, 7], 'Same turn must not consume a new batch during tool continuation'
    assert ctx.posts == ['Clanker Chat · 1 unread', 'Clanker Chat · 1 unread']
    assert owner(ctx, 3) is None, 'A displayed batch is delivered only once, not once per owner turn'
    assert owner(ctx, 1) is None, 'Replayed earlier turns stay deduplicated'
    ctx.cleanup()

    note_calls.clear()
    results.clear()
    ctx = scheduled([batch5, batch5], lambda ctx: {
        0: lambda: results.append(owner(ctx, 1)),
        1: lambda: results.append(owner(ctx, 1)),
        2: lambda: results.append(owner(ctx, 2)),
    })
    assert results == [None, None, {'context': 'QUOTED NOTE 5'}]
    assert note_calls == [5], 'Even no-batch first calls must latch the owner turn'
    ctx.cleanup()

    class FailedDisplay(Context):
        def post_message(self, text):
            return types.SimpleNamespace(ok=False)

    ctx = scheduled([batch5], lambda _: {}, FailedDisplay([batch5]))
    assert owner(ctx) is None and note_calls == [5], 'A failed/deferred display must not arm a note'
    ctx.cleanup()

    # Controls and our injected notices never reserve an owner count or request context.
    note_calls.clear()
    ctx = scheduled([batch5], lambda _: {})
    skipped = [
        '', '   ', '/status', '!pwd',
        'Clanker Chat local discussion work: 0000. Continue the accepted discussion.',
        'Clanker Chat local discussion notice. Continue the accepted discussion.',
        'Clanker Chat · 1 unread',
    ]
    for text in skipped:
        assert owner(ctx, text=text) is None, text
    for platform in ['subagent', 'telegram', 'discord', 'slack', 'cron']:
        assert owner(ctx, platform=platform) is None
        assert owner(ctx, extra={'platform': platform}) is None
    for flags in [
        {'is_subagent': True}, {'is_synthetic': True}, {'synthetic': True}, {'internal': True},
        {'parent_session_id': 'parent'}, {'parentSessionId': 'parent'}, {'parent_agent_id': 'parent'},
        {'source': 'synthetic'}, {'source': 'internal'}, {'source': 'subagent'},
    ]:
        assert owner(ctx, **flags) is None
        assert owner(ctx, extra=flags) is None
    assert owner(ctx, conversation_history=None) is None
    assert owner(ctx, conversation_history=[]) is None
    assert owner(ctx, session_id='unbound') is None
    assert owner(ctx, user_message=None) is None
    assert owner(ctx, user_message=[{'type': 'image_url', 'image_url': 'example'}]) is None
    assert not note_calls
    assert owner(ctx, text='Please answer.') == {'context': 'QUOTED NOTE 5'}
    assert note_calls == [5], 'Skips must not consume the next normal owner turn'
    ctx.cleanup()

    for message in [
        [{'type': 'text', 'text': 'Please answer.'}, {'type': 'image_url', 'image_url': 'example'}],
    ]:
        ctx = scheduled([batch5], lambda _: {})
        assert owner(ctx, text=message) == {'context': 'QUOTED NOTE 5'}
        ctx.cleanup()

    # Setting-off, empty responses, errors and revocation fail open, consuming
    # this batch's next-owner opportunity even if access/setting later recovers.
    for result in [{}, {'additionalContext': ''}, {'additionalContext': 7}, OSError('offline'), PermissionError('revoked')]:
        ctx = scheduled([batch5], lambda _: {})
        with patch.object(plugin, '_notification_context', side_effect=result if isinstance(result, Exception) else None,
                          return_value=result) as fetch:
            assert owner(ctx) is None
            assert owner(ctx, turn_id='another-id') is None
            assert fetch.call_count == 1
        assert owner(ctx, 2) is None, 'Recovery/re-enable must not attach an old displayed batch'
        ctx.cleanup()

    for failure in [{}, OSError('offline')]:
        results.clear()
        def failed_owner(ctx):
            with patch.object(plugin, '_notification_context', side_effect=failure if isinstance(failure, Exception) else None,
                              return_value=failure) as fetch:
                assert owner(ctx) is None
                assert owner(ctx, turn_id='retry') is None
                assert fetch.call_count == 1
            assert owner(ctx, 2) is None, 'Same batch stays consumed after recovery or note-on'
        ctx = scheduled([batch5, batch7], lambda ctx: {
            1: lambda: failed_owner(ctx),
            2: lambda: results.append(owner(ctx, 3)),
        })
        assert results == [{'context': 'QUOTED NOTE 7'}], 'A newly displayed batch must rearm after failure'
        ctx.cleanup()

    # Reading all messages before the owner prompt disarms the pending batch.
    ctx = scheduled([batch5, {'latest': 5, 'unread': 0, 'unreadFirst': 0}], lambda _: {})
    assert owner(ctx) is None
    ctx.cleanup()

    for event, key in [('on_session_finalize', 'session_id'), ('on_session_reset', 'old_session_id')]:
        ctx = scheduled([batch5], lambda _: {})
        ctx.hooks[event](**{key: 'owner-session'})
        assert owner(ctx) is None
        ctx.hooks['on_session_start'](session_id='owner-session', platform='cli')
        assert owner(ctx) == {'context': 'QUOTED NOTE 5'}, 'New lifecycle must clear dedupe state'
        ctx.cleanup()
        assert owner(ctx, 2) is None
        assert not ctx.hooks['on_session_start'](session_id='after-unload')

    ctx = scheduled([batch5], lambda _: {})
    def finish_during_fetch(_):
        ctx.hooks['on_session_finalize'](session_id='owner-session')
        return {'additionalContext': 'must not escape finalized session'}
    with patch.object(plugin, '_notification_context', finish_during_fetch):
        assert owner(ctx) is None
    ctx.cleanup()

# Exercise the actual private transport: authenticated request shape, rotated
# credentials, failures and a dribbling response that defeats idle-only timeout.
transport_fetch = plugin._notification_context
with tempfile.TemporaryDirectory(prefix='cc-hermes-') as temporary:
    root = Path(temporary)
    connection_file = root / 'connection.json'
    requests = []
    failures = []
    def serve_once(status=200, value=None, dribble=False):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(root / 'daemon.sock'))
        listener.listen(1)
        def serve():
            try:
                with listener.accept()[0] as connection:
                    connection.settimeout(2)
                    raw = b''
                    while b'\r\n\r\n' not in raw:
                        raw += connection.recv(4096)
                    headers, body = raw.split(b'\r\n\r\n', 1)
                    length = int(re.search(rb'Content-Length: (\d+)', headers, re.I)[1])
                    while len(body) < length:
                        body += connection.recv(4096)
                    requests.append((headers.decode(), json.loads(body)))
                    payload = json.dumps(value if value is not None else {'additionalContext': 'transport note'}).encode()
                    connection.sendall(f'HTTP/1.1 {status} Test\r\nContent-Length: {len(payload)}\r\n\r\n'.encode())
                    if dribble:
                        for byte in payload:
                            time.sleep(0.08)
                            connection.sendall(bytes([byte]))
                    else:
                        connection.sendall(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                failures.append(error)
            finally:
                listener.close()
        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        return worker

    with patch.object(plugin, '__file__', str(root / '__init__.py')):
        for token in ['initial-test-credential', 'rotated-test-credential']:
            connection_file.write_text(json.dumps({'home': temporary, 'id': 'hermes', 'token': token}))
            worker = serve_once()
            assert transport_fetch(5) == {'additionalContext': 'transport note'}
            worker.join(2)
            (root / 'daemon.sock').unlink()
            headers, request = requests[-1]
            assert f'x-clanker-token: {token}\r\n' in headers
            assert 'x-clanker-origin: mcp\r\n' in headers and 'x-clanker-client: hermes\r\n' in headers
            assert request == {'command': 'notification_context', 'args': {'boundary': 5}}
        for status, value in [(403, {'error': 'revoked'}), (200, {}), (200, [])]:
            worker = serve_once(status, value)
            assert transport_fetch(5) == {}
            worker.join(2)
            (root / 'daemon.sock').unlink()
        ctx = scheduled([batch5], lambda _: {})
        worker = serve_once(dribble=True)
        started = time.monotonic()
        assert owner(ctx) is None, 'Slow daemon must fail open on the existing owner call'
        assert time.monotonic() - started < 1.2, 'Deadline must bound wall time, not socket idle time'
        assert owner(ctx) is None, 'A slow request must not retry on tool continuation'
        ctx.cleanup()
        worker.join(2)
        (root / 'daemon.sock').unlink()
        assert not failures, failures
        ctx = scheduled([batch5], lambda _: {})
        assert owner(ctx) is None, 'A stopped daemon must not block the normal owner call'
        connection_file.unlink()
        assert owner(ctx, 2) is None, 'Removed app wiring must fail open'
        ctx.cleanup()

# Bridge workers still register only the read-only toolset, never note/listener hooks.
with patch.dict(plugin.os.environ, {'CLANKER_BRIDGE_RUN': 'test-run'}):
    bridge = Context()
    plugin.register(bridge)
    assert not bridge.hooks and not bridge.commands and not bridge.calls

print('Hermes native owner context, per-turn/batch dedupe, skips, lifecycle and bounded private transport passed')
