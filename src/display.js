import { stripVTControlCharacters } from 'node:util';

// Direction overrides and terminal controls must never change how remote data reads.
export function displayText(value, { multiline = false } = {}) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, '');
}

// Apply before JSON encoding, so escaped controls cannot reappear in a tool UI.
export const displayJson = (value, space) => JSON.stringify(value, (_, item) => typeof item === 'string' ? displayText(item, { multiline: true }) : item, space);

export const MAX_TIMESTAMP = 8.64e15;
export const validTimestamp = ms => Number.isInteger(ms) && ms > 0 && ms <= MAX_TIMESTAMP;
// Old databases can contain sender timestamps outside Date's range.
export const iso = ms => validTimestamp(ms) ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : null;
