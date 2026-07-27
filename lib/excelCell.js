/**
 * Shared numeric reader for worksheet cells.
 *
 * Cells that LOOK numeric in Excel are not always stored as numbers: a value
 * pasted in from a report or a PDF stays a text cell (`t === "s"`) carrying the
 * display formatting, e.g. " 378,263.86 ". A plain Number() on that returns NaN,
 * and the `Number(cell.v) || 0` idiom then silently writes a 0 to the database -
 * which is how January 2026 lost its per-building electricity (every Jan-2026
 * cell in the "1.1_Individual Pod" tab is text) and how 2024 lost its solar
 * urban-renewables figures.
 *
 * So: accept real numbers as-is, and for text cells strip the thousands
 * separators, currency symbols and surrounding whitespace before parsing.
 * Anything still unparseable is reported through onBadCell instead of quietly
 * becoming 0.
 *
 * @param {object} sheet     XLSX worksheet object
 * @param {string} address   Cell address, e.g. "D35"
 * @param {(address: string, value: unknown) => void} [onBadCell]
 * @returns {number}
 */
function readNumericCell(sheet, address, onBadCell) {
  const cell = sheet[address];
  if (!cell || cell.v === undefined || cell.v === null) return 0;

  if (typeof cell.v === "number") return Number.isFinite(cell.v) ? cell.v : 0;
  if (typeof cell.v === "boolean") return 0;

  const raw = String(cell.v).trim();
  if (raw === "" || raw === "-") return 0;

  // " 1,234.56 " / "$1,234.56" / "(1,234.56)" -> 1234.56 / 1234.56 / -1234.56
  const negative = /^\(.*\)$/.test(raw);
  const cleaned = raw
    .replace(/^\(|\)$/g, "")
    .replace(/[,\s]/g, "")
    .replace(/^[^\d.+-]+/, "");

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    if (onBadCell) onBadCell(address, cell.v);
    return 0;
  }

  return negative ? -parsed : parsed;
}

module.exports = { readNumericCell };
