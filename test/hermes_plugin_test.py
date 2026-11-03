"""Exercise the plugin against Hermes' JSON-text envelope without a model/provider."""
import importlib.util
import json
import re
import sys
import threading
import types

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

    def set(self):
        self.stopped = True


class InlineThread:
    def __init__(self, target, **_kwargs):
        self.target = target

    def start(self):
        self.target()


plugin.threading = types.SimpleNamespace(Event=PollEvent, Thread=InlineThread, Lock=threading.Lock)


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
assert 'pre_llm_call' not in ctx.hooks, 'Without a trusted user-origin discriminator Hermes must remain display-only'
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
    assert 'pre_llm_call' not in revoked.hooks
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


