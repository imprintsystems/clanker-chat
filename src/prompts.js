// Interactive prompts drawn in the Clanker Chat style, on top of @clack/core's
// keyboard handling. Same call shapes as @clack/prompts, so tests can pass fakes.
import { TextPrompt, SelectPrompt, MultiSelectPrompt, ConfirmPrompt, isCancel } from '@clack/core';
import { theme as t, banner, clean, wrap, width } from './terminal.js';

export { isCancel };
const out = process.stdout;
const write = text => out.write(text);
const margin = '  ';
const bar = () => t.faint('│');
const symbols = { submit: t.muted('◇'), cancel: t.bad('■'), error: t.warn('▲') };
const symbol = state => symbols[state] || '◆';
const title = (state, message) => `${margin}${bar()}\n${margin}${symbol(state)}  ${state === 'submit' || state === 'cancel' ? t.muted(message) : t.strong(message)}\n`;
const done = (state, value) => `${margin}${bar()}  ${t.muted(state === 'cancel' ? 'Cancelled' : value)}`;
const foot = (state, error, help) => `${margin}${t.faint('└')}  ${state === 'error' ? t.warn(error) : t.faint(help)}\n`;

export function intro(subtitle) { banner(subtitle); }
export function outro(message) { write(`${margin}${bar()}\n${margin}${t.faint('└')}  ${message}\n\n`); }
export function cancel(message) { outro(t.muted(message)); }

const logLine = (mark, message) => {
  const [first, ...rest] = wrap(message, width() - 9);
  write(`${margin}${bar()}\n${margin}${mark}  ${first}\n${rest.map(row => `${margin}${bar()}  ${row}\n`).join('')}`);
};
export const log = {
  info: message => logLine(t.muted('●'), message),
  success: message => logLine(t.good('✓'), message),
  error: message => logLine(t.bad('×'), message)
};

export function note(body, heading) {
  write(`${margin}${bar()}\n${margin}${t.muted('◇')}  ${t.strong(heading)}\n`);
  for (const line of String(body).split('\n').flatMap(line => line ? wrap(line, Math.min(68, width() - 12)) : [''])) write(`${margin}${bar()}  ${line}\n`);
}

export function text({ message, placeholder = '', initialValue, validate }) {
  return new TextPrompt({ initialValue, validate, render() {
    if (this.state === 'submit' || this.state === 'cancel') return title(this.state, message) + done(this.state, this.value);
    const input = this.userInput ? this.userInputWithCursor : placeholder ? `${t.inverse(placeholder[0])}${t.muted(placeholder.slice(1))}` : '█';
    return `${title(this.state, message)}${margin}${bar()}  ${input}\n${foot(this.state, this.error, 'enter to continue')}`;
  } }).prompt();
}

const row = (item, here, mark) => {
  const prefix = `${margin}${bar()}  ${mark} `;
  const indent = `${margin}${bar()}  ${' '.repeat(clean(mark).length + 1)}`;
  const room = width() - clean(prefix).length;
  if (item.label.length + (item.hint ? item.hint.length + 2 : 0) <= room) return `${prefix}${here ? item.label : t.muted(item.label)}${item.hint ? `  ${t.faint(item.hint)}` : ''}`;
  const labels = wrap(item.label, room).map((text, i) => `${i ? indent : prefix}${here ? text : t.muted(text)}`);
  const hints = item.hint ? wrap(item.hint, room).map(text => `${indent}${t.faint(text)}`) : [];
  return [...labels, ...hints].join('\n');
};

export function select({ message, options, initialValue }) {
  return new SelectPrompt({ options, initialValue, render() {
    if (this.state === 'submit' || this.state === 'cancel') return title(this.state, message) + done(this.state, options.find(item => item.value === this.value)?.label);
    const list = options.map((item, i) => row(item, i === this.cursor, i === this.cursor ? '●' : t.faint('○')));
    return `${title(this.state, message)}${list.join('\n')}\n${foot(this.state, this.error, '↑↓ move · enter choose')}`;
  } }).prompt();
}

export function multiselect({ message, options, initialValues = [], required = false }) {
  return new MultiSelectPrompt({ options, initialValues, required, render() {
    if (this.state === 'submit' || this.state === 'cancel') {
      const picked = options.filter(item => this.value?.includes(item.value)).map(item => item.label);
      return title(this.state, message) + done(this.state, picked.length ? picked.join(', ') : 'none');
    }
    const list = options.map((item, i) => {
      const on = this.value?.includes(item.value), here = i === this.cursor;
      const box = item.disabled ? t.faint('–') : on ? t.good('■') : t.faint('□');
      return row(item, here || on, `${here ? '›' : ' '} ${box}`);
    });
    return `${title(this.state, message)}${list.join('\n')}\n${foot(this.state, this.error, '↑↓ move · space select · enter confirm')}`;
  } }).prompt();
}

export function confirm({ message, initialValue = true }) {
  return new ConfirmPrompt({ active: 'Yes', inactive: 'No', initialValue, render() {
    if (this.state === 'submit' || this.state === 'cancel') return title(this.state, message) + done(this.state, this.value ? 'Yes' : 'No');
    const choice = this.value ? `● Yes   ${t.muted('○ No')}` : `${t.muted('○ Yes')}   ● No`;
    return `${title(this.state, message)}${margin}${bar()}  ${choice}\n${foot(this.state, this.error, '←→ switch · enter confirm')}`;
  } }).prompt();
}

export function spinner() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const live = !!out.isTTY;
  let timer, label = '', i = 0;
  return {
    start(message) {
      label = message; write(`${margin}${bar()}\n`);
      if (!live) return write(`${margin}${t.muted('◇')}  ${label}\n`);
      write('\x1b[?25l');
      timer = setInterval(() => write(`\r${margin}${frames[i++ % frames.length]}  ${label}`), 80);
    },
    stop(message, failed = false) {
      clearInterval(timer);
      const mark = failed ? t.bad('×') : t.good('✓');
      write(live ? `\r\x1b[2K${margin}${mark}  ${message}\n\x1b[?25h` : `${margin}${mark}  ${message}\n`);
    }
  };
}
