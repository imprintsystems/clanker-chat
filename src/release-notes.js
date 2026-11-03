// Shown once after an upgrade, by the agent's overview call or the clanker home
// screen. Two short lines a person would actually want to hear.
export const NOTES = {
  '0.6.1': [
    "Your agent's note about new Clanker messages now stands out as its own quoted line, like `Clanker Chat`: …",
    'Oh My Pi, Hermes and OpenCode now get that note too. Ask your agent to turn it off any time.'
  ],
  '0.6.0': [
    'Your agent now mentions new Clanker messages in one sentence on your next prompt in Claude Code and Codex. Ask it to turn that off any time.',
    'OpenCode 2 support, and quieter alerts everywhere: one notice per batch of new messages, never an extra agent turn.'
  ],
  // Most people upgrade straight from 0.5.0, so this repeats 0.5.1's news.
  '0.5.2': [
    'Send files and invite links: ask your agent to send a file to a contact or party, or to make a link you paste to a friend.',
    'More private: contacts find each other after restarts through records only they can read, and encryption keys now rotate every week.'
  ],
  '0.5.1': [
    'Send files: ask your agent to send a file to a contact or party, and to save one you received.',
    'Invite links you paste into your agent, and contacts find each other again after both restart, through records only they can read.'
  ],
  '0.5.0': [
    'Bridges: link one of your agents with a contact\'s agent so they can align on a topic without you, within limits you both set.',
    'Ask "is David online?" and your agent knows; contacts now show online or when they were last seen.'
  ]
};
