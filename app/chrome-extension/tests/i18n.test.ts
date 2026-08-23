import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Message = { message: string; placeholders?: Record<string, { content: string }> };

const LOCALES = ['zh_CN', 'en', 'ja'] as const;
const load = (locale: string): Record<string, Message> =>
  JSON.parse(readFileSync(join(__dirname, `../_locales/${locale}/messages.json`), 'utf8'));

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.(ts|vue)$/.test(entry)) found.push(path);
  }
  return found;
}

describe('i18n messages', () => {
  const zh = load('zh_CN');

  it('keeps every locale on the same key set', () => {
    for (const locale of LOCALES.slice(1)) {
      expect({ locale, keys: Object.keys(load(locale)).sort() }).toEqual({
        locale,
        keys: Object.keys(zh).sort(),
      });
    }
  });

  it('declares a placeholder for every substitution slot', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(load(locale))) {
        const slots = new Set(entry.message.match(/\$[A-Za-z][A-Za-z0-9_]*\$/g) || []);
        const declared = new Set(
          Object.keys(entry.placeholders || {}).map((name) => `$${name.toUpperCase()}$`),
        );
        expect({ locale, key, slots: [...slots].sort() }).toEqual({
          locale,
          key,
          slots: [...declared].sort(),
        });
      }
    }
  });

  it('resolves every message key the code asks for', () => {
    const missing: string[] = [];
    for (const file of sources(join(__dirname, '../entrypoints'))) {
      const code = readFileSync(file, 'utf8');
      // t('key') / getMessage('key') / d('key') — the last is prefixed ovDetail_.
      for (const [, fn, key] of code.matchAll(/\b(t|getMessage|d)\(\s*'([A-Za-z0-9_]+)'/g)) {
        const full = fn === 'd' ? `ovDetail_${key}` : key;
        if (!(full in zh)) missing.push(`${full} (${file.split('/').slice(-2).join('/')})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
