/**
 * Repairs rows that were imported as 0 because their Excel cell was stored as
 * text (" 378,263.86 ") rather than a number - the bug fixed in lib/excelCell.js.
 *
 * Re-reads the source workbook with the corrected parser and UPDATEs only the
 * rows whose stored value is 0 but whose workbook cell holds a real number.
 * Nothing is deleted and no non-zero value is overwritten, so it is safe to
 * re-run. Any future upload through the app already imports these correctly -
 * this only backfills data loaded before the fix.
 *
 * Usage:
 *   node scripts/repair-text-formatted-cells.js "<path to .xlsx>" [--apply]
 *
 * Without --apply it runs as a dry run and only prints what it would change.
 */

const path = require("path");
const XLSX = require("xlsx");
const mysql = require("mysql2/promise");
const { readNumericCell } = require("../lib/excelCell");
const { BuildingNameStandardized } = require("../lib/buildingNames");

require("dotenv").config({ path: path.join(__dirname, "..", "databaseinfo.env") });

const APPLY = process.argv.includes("--apply");
const workbookPath = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!workbookPath) {
  console.error('Usage: node scripts/repair-text-formatted-cells.js "<path to .xlsx>" [--apply]');
  process.exit(1);
}

async function main() {
  const wb = XLSX.readFile(workbookPath);
  const sheet2 = wb.Sheets[wb.SheetNames[1]]; // 1.1_Individual Pod (building electricity)
  const sheet5 = wb.Sheets[wb.SheetNames[4]]; // 3_Solar Data

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    dateStrings: true,
  });

  const planned = [];

  /* ---------- Tab 2: building electricity ---------- */
  const monthNames = ["january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"];

  for (let r = 1; r <= 300; r++) {
    const label = sheet2[`B${r}`];
    if (!label || label.v === undefined || label.v === null) continue;
    const cyMatch = String(label.v).match(/CY\s*(\d{4})/i);
    if (!cyMatch) continue;
    const year = parseInt(cyMatch[1], 10);
    if (!(year >= 2000 && year <= 2100)) continue;

    let janRow = null;
    for (let rr = r + 1; rr <= r + 6; rr++) {
      const c = sheet2[`B${rr}`];
      if (c && String(c.v).trim().toLowerCase() === "january") { janRow = rr; break; }
    }
    if (!janRow) continue;

    const headerRow = janRow - 1;
    for (let colIndex = 2; colIndex <= 23; colIndex++) {
      const col = XLSX.utils.encode_col(colIndex);
      const building = BuildingNameStandardized(sheet2[`${col}${headerRow}`]?.v);
      if (!building) continue;

      for (let m = 0; m < 12; m++) {
        const row = janRow + m;
        if (String(sheet2[`B${row}`]?.v || "").trim().toLowerCase() !== monthNames[m]) continue;
        const value = readNumericCell(sheet2, `${col}${row}`);
        if (!(value > 0)) continue;
        planned.push({
          table: "building_ebills",
          column: "bill_amount",
          where: "building_name = ? AND bill_month = ?",
          params: [building, `${year}-${String(m + 1).padStart(2, "0")}-01`],
          value,
          label: `building_ebills ${building} ${year}-${String(m + 1).padStart(2, "0")}`,
        });
      }
    }
  }

  /* ---------- Tab 5: solar ---------- */
  {
    let year = null;
    let monthIndex = 0;
    for (let r = 3; r <= 200; r++) {
      const yearCell = sheet5[`B${r}`];
      if (yearCell && Number.isFinite(Number(yearCell.v)) && Number(yearCell.v) >= 2000 && Number(yearCell.v) <= 2100) {
        year = Number(yearCell.v);
        monthIndex = 0;
      }
      if (year === null) continue;
      if (monthIndex > 11) continue;
      if (!sheet5[`C${r}`] && !sheet5[`D${r}`] && !sheet5[`E${r}`]) continue;

      const month = String(monthIndex + 1).padStart(2, "0");
      const urban = readNumericCell(sheet5, `D${r}`);
      const green = readNumericCell(sheet5, `E${r}`);
      if (urban > 0) {
        planned.push({
          table: "total_solardata", column: "urban_renewables",
          where: "bill_month = ?", params: [`${year}-${month}-01`], value: urban,
          label: `total_solardata urban_renewables ${year}-${month}`,
        });
      }
      if (green > 0) {
        planned.push({
          table: "total_solardata", column: "green_house",
          where: "bill_month = ?", params: [`${year}-${month}-01`], value: green,
          label: `total_solardata green_house ${year}-${month}`,
        });
      }
      monthIndex++;
    }
  }

  /* ---------- Apply only where the DB currently holds 0 ---------- */
  const [accounts] = await db.query("SELECT DISTINCT account_id FROM building_ebills");
  const accountIds = accounts.map((a) => a.account_id);

  let changed = 0;
  for (const accountId of accountIds) {
    for (const p of planned) {
      const [rows] = await db.query(
        `SELECT ${p.column} AS current FROM ${p.table} WHERE account_id = ? AND ${p.where}`,
        [accountId, ...p.params]
      );
      if (rows.length === 0) continue;
      if (Number(rows[0].current) !== 0) continue; // never overwrite real data

      console.log(`${APPLY ? "FIX " : "DRY "} account ${accountId}: ${p.label}  0 -> ${p.value}`);
      changed++;

      if (APPLY) {
        await db.query(
          `UPDATE ${p.table} SET ${p.column} = ? WHERE account_id = ? AND ${p.where}`,
          [p.value, accountId, ...p.params]
        );
      }
    }
  }

  console.log(`\n${APPLY ? "Updated" : "Would update"} ${changed} row(s).`);
  if (!APPLY && changed > 0) console.log("Re-run with --apply to write the changes.");

  await db.end();
}

main().catch((err) => {
  console.error("Repair failed:", err.message);
  process.exit(1);
});
