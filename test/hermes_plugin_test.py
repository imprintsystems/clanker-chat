"""Exercise the plugin against Hermes' JSON-text envelope without a model/provider."""
import importlib.util
import json
import sys
import threading
import time
import types

sys.modules['toolsets'] = types.SimpleNamespace(create_custom_toolset=lambda *args, **kwargs: None)

spec = importlib.util.spec_from_file_location('clanker_plugin', sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class Context:
    def __init__(self):
        self.hooks, self.commands, self.posts = {}, {}, []
        self.done = threading.Event()
        self.calls = 0

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
        return {'ok': True, 'result': json.dumps({'latest': 5, 'unread': 1, 'private': 'REMOTE SECRET'})}

    def post_message(self, text):
        assert 'REMOTE SECRET' not in text
        self.posts.append(text)
        self.done.set()
        return type('Posted', (), {'ok': True})()

    def inject_message(self, *_, **__):
        raise AssertionError('A display-only post must not start a model turn')


ctx = Context()
plugin.register(ctx)
try:
    ctx.hooks['on_session_start'](session_id='test-session')
    assert ctx.done.wait(3.5), 'No notice was posted'
    time.sleep(2.2)
    assert ctx.calls >= 2 and len(ctx.posts) == 1, 'Notice was duplicated'
finally:
    ctx.cleanup()
remote = Context()
remote.session_surface = lambda: 'telegram'
plugin.register(remote)
remote.hooks['on_session_start'](session_id='not-a-local-chat')
assert remote.calls == 0 and not remote.posts
remote.cleanup()
print('Hermes JSON-text status, display-only routing, deduplication and cleanup passed')


class DiscussionContext(Context):
    def __init__(self):
        super().__init__()
        self.injections = []

    def call_mcp(self, server, tool, args, **_):
        if tool == 'clanker_discussion_work':
            return {'ok': True, 'result': json.dumps([{'id': '00000000-0000-4000-8000-000000000001', 'revision': 2, 'kind': 'turn', 'text': 'REMOTE SECRET'}])}
        return {'ok': True, 'result': '{"latest":0,"unread":0}'}

    def inject_message(self, text, session_key):
        assert 'REMOTE SECRET' not in text and 'clanker_discussion_next' in text
        assert session_key == 'discussion-session'
        self.injections.append(text)
        self.done.set()
        return True


discussion = DiscussionContext()
plugin.register(discussion)
try:
    discussion.hooks['on_session_start'](session_id='discussion-session')
    assert discussion.done.wait(3.5), 'Accepted discussion did not request a local turn'
    time.sleep(2.2)
    assert len(discussion.injections) == 1, 'The same work caused duplicate model wake-ups'
finally:
    discussion.cleanup()
print('Hermes accepted-discussion injection contains metadata only and is deduplicated')
