import de from './locales/de.json';
import en from './locales/en.json';
import sq from './locales/sq.json';

/**
 * D110: every language has every text of the English file, with the same {{placeholders}} and tags, so a text
 * added in English only fails here instead of showing English in the middle of a German or Albanian page.
 */

type Texts = { [key: string]: string | Texts };

function flatten(texts: Texts, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(texts)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [inner, text] of flatten(value, path)) out.set(inner, text);
  }
  return out;
}

const marks = (text: string) => (text.match(/\{\{\s*[\w.]+\s*\}\}|<\/?\d+>|<\/?b>/g) ?? []).sort();
const english = flatten(en as Texts);

describe.each([
  ['German', de],
  ['Albanian', sq],
])('the %s texts', (_name, texts) => {
  const translated = flatten(texts as Texts);

  it('have exactly the keys of the English file', () => {
    expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('keep every placeholder and tag of the English text', () => {
    const wrong = [...english].filter(([key, text]) => JSON.stringify(marks(text)) !== JSON.stringify(marks(translated.get(key) ?? '')));
    expect(wrong.map(([key]) => key)).toEqual([]);
  });

  it('name each language in itself, the same in every file', () => {
    expect(translated.get('language.names.en')).toBe('English');
    expect(translated.get('language.names.de')).toBe('Deutsch');
    expect(translated.get('language.names.sq')).toBe('Shqip');
  });
});
