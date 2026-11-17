/**
 * A very small PDF writer for receipts (D67): one or more A4 pages of text lines in Helvetica, with no
 * dependency. Enough for a receipt; anything richer would call for a real PDF library.
 */

export interface PdfLine {
  text: string;
  /** Points from the left edge; text right-aligned at this point when `align` is "right". */
  x: number;
  /** Points from the top edge. */
  y: number;
  size?: number;
  bold?: boolean;
  align?: 'left' | 'right';
  /** A thin line across the page under this position instead of text. */
  rule?: boolean;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

/**
 * Helvetica glyph widths (per 1000 units) for the characters receipts use, so text can be right-aligned.
 * Characters not listed count as an average width.
 */
const WIDTHS: Record<string, number> = {
  ' ': 278, '.': 278, ',': 278, ':': 278, '-': 333, '#': 556, '(': 333, ')': 333, '/': 278, '·': 278, '€': 556, '%': 889,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
};
const AVERAGE_WIDTH = 556;

/** Width of a text in points, close enough to right-align amounts. */
export function textWidth(text: string, size: number, bold = false): number {
  let units = 0;
  for (const char of text) units += WIDTHS[char] ?? (char === char.toUpperCase() && /[A-Z]/.test(char) ? 667 : AVERAGE_WIDTH);
  return (units / 1000) * size * (bold ? 1.05 : 1);
}

/**
 * The text as WinAnsi bytes inside a PDF string: brackets and backslashes escaped, the euro sign and the
 * middle dot mapped to their WinAnsi codes, anything else outside Latin-1 replaced by "?".
 */
export function pdfString(text: string): string {
  let out = '';
  for (const char of text) {
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (char === '€') out += '\\200';
    else if (char === '·') out += '\\267';
    else if (char === '–') out += '\\226';
    else if (char === '’') out += '\\222';
    else {
      const code = char.codePointAt(0) ?? 63;
      if (code >= 32 && code < 127) out += char;
      else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
      else out += '?';
    }
  }
  return `(${out})`;
}

function pageContent(lines: PdfLine[]): string {
  const ops: string[] = [];
  for (const line of lines) {
    const y = PAGE_HEIGHT - line.y;
    if (line.rule) {
      ops.push(`0.85 G 0.6 w ${line.x.toFixed(2)} ${y.toFixed(2)} m ${(PAGE_WIDTH - line.x).toFixed(2)} ${y.toFixed(2)} l S 0 G`);
      continue;
    }
    const size = line.size ?? 11;
    const x = line.align === 'right' ? line.x - textWidth(line.text, size, line.bold) : line.x;
    ops.push(`BT /${line.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(line.text)} Tj ET`);
  }
  return ops.join('\n');
}

/** A complete PDF file with one page per entry of `pages`. */
export function renderPdf(pages: PdfLine[][], title: string): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${pdfString(title)} /Producer (MISK) >>`);
  const pageIds: number[] = [];
  for (const lines of pages) {
    const content = pageContent(lines);
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
