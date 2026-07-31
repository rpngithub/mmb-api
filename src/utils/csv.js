// Zero-dependency RFC-4180 CSV parser + serializer.
//
// parse(text) -> { header, rows } where each row is { line, values }.
//   - A leading UTF-8 BOM is stripped.
//   - Blank lines are ignored.
//   - Lines whose first cell (after trimming) begins with '#' are ignored — this
//     is how help text and the inert example rows in the downloadable templates
//     are skipped on re-upload.
//   - Quoted fields, commas/newlines inside quotes, and escaped quotes ("") are
//     all handled (a naive split(',') would corrupt real data).
//   - `line` is the 1-based source line where the record began, for row-level
//     error reporting that lines up with what the admin sees in Excel.

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// Split raw text into records; each record is { fields: string[], line }.
function tokenize(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let started = false;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { endField(); records.push({ fields: record, line: startLine }); record = []; started = false; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!started) { startLine = line; started = true; }

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
        if (c === '\n') line++; // newline inside a quoted value
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;            // swallow CR of a CRLF pair
    if (c === '\n') { endRecord(); line++; continue; }
    field += c;
  }
  if (started || field !== '' || record.length) endRecord();
  return records;
}

function parse(text) {
  const records = tokenize(stripBom(String(text || '')));
  const meaningful = records.filter((r) => {
    const first = r.fields[0] !== undefined ? String(r.fields[0]) : '';
    if (r.fields.length === 1 && first.trim() === '') return false;       // blank line
    if (first.trimStart().startsWith('#')) return false;                   // comment / help / example
    return true;
  });
  if (!meaningful.length) return { header: [], rows: [] };

  const header = meaningful[0].fields.map((h) => h.trim());
  const rows = meaningful.slice(1).map((rec) => {
    const values = {};
    header.forEach((h, i) => { values[h] = rec.fields[i] !== undefined ? rec.fields[i] : ''; });
    return { line: rec.line, values };
  });
  return { header, rows };
}

// Quote a single field only when needed (contains a delimiter/quote/newline or
// has surrounding whitespace), doubling any embedded quotes.
function quoteField(v) {
  const s = v == null ? '' : String(v);
  return /["\r\n,]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Serialize one array of cells into a CSV line.
function csvLine(cells) {
  return cells.map(quoteField).join(',');
}

module.exports = { parse, stripBom, quoteField, csvLine };
