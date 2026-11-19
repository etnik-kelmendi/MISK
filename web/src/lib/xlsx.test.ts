import { describe, expect, it } from 'vitest';
import { crc32, toXlsx, xmlEscape } from './xlsx';

interface ZipEntry {
  name: string;
  text: string;
  crc: number;
  method: number;
}

/** Reads a stored zip by walking its local headers. */
function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let pos = 0;
  while (view.getUint32(pos, true) === 0x04034b50) {
    const method = view.getUint16(pos + 8, true);
    const crc = view.getUint32(pos + 14, true);
    const size = view.getUint32(pos + 18, true);
    const nameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      text: decoder.decode(bytes.slice(dataStart, dataStart + size)),
      crc,
      method,
    });
    pos = dataStart + size;
  }
  return entries;
}

function sheetOf(bytes: Uint8Array): string {
  const sheet = readZip(bytes).find((entry) => entry.name === 'xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('No sheet');
  return sheet.text;
}

describe('crc32', () => {
  it('matches known values', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('toXlsx', () => {
  const bytes = toXlsx([['Tab', 'All'], [], ['Value'], [48.4]], { sheetName: 'Bookings', boldRows: [2] });

  it('is a zip with the parts of a workbook', () => {
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const entries = readZip(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    // Stored, with a correct CRC-32 for every entry.
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.crc).toBe(crc32(new TextEncoder().encode(entry.text)));
    }
    expect(entries.find((entry) => entry.name === 'xl/workbook.xml')?.text).toContain('name="Bookings"');
  });

  it('ends with a valid end-of-central-directory record', () => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 8, true)).toBe(6);
    expect(view.getUint16(end + 10, true)).toBe(6);
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(end + 12, true)).toBe(end - centralOffset);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
  });

  it('writes numbers as numeric cells and text as inline strings, bold where asked', () => {
    const sheet = sheetOf(bytes);
    expect(sheet).toContain('<c r="A4"><v>48.4</v></c>');
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Tab</t></is></c>');
    expect(sheet).toContain('<c r="A3" s="1" t="inlineStr">');
    expect(sheet).toContain('<row r="2"></row>');
  });

  it('escapes XML and keeps formula-looking text as plain text', () => {
    const sheet = sheetOf(toXlsx([['A & B <i> "q" \'s\'', '=SUM(A1:A2)', '+1', 'ok\u0000\u0008x']]));
    expect(sheet).toContain('A &amp; B &lt;i&gt; &quot;q&quot; &apos;s&apos;');
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=SUM(A1:A2)</t>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('>okx</t>');
  });

  it('keeps accents and names columns past Z', () => {
    const row = Array.from({ length: 28 }, (_, i) => (i === 27 ? 'Jürgen' : i));
    const sheet = sheetOf(toXlsx([row]));
    expect(sheet).toContain('r="AB1"');
    expect(sheet).toContain('Jürgen');
  });

  it('drops characters XML cannot hold', () => {
    expect(xmlEscape('a￾b\uD800c')).toBe('abc');
    expect(xmlEscape('😀')).toBe('😀');
  });
});
