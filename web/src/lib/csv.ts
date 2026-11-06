/** Builds CSV files that open cleanly in Excel, Numbers and Google Sheets. */

// A byte order mark tells Excel the file is UTF-8, so names like "Jürgen" are shown right.
const BOM = String.fromCharCode(0xfeff);

// Cells starting with these are run as formulas by spreadsheet apps (CSV injection), so they get a leading quote.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `${BOM}${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Hands the browser a file to save. */
export function downloadFile(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
