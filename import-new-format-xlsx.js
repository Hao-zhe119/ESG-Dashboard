require("dotenv").config({ path: "./databaseinfo.env" });

const path = require("path");
const XLSX = require("xlsx");
const mysql = require("mysql2/promise");

const DEFAULT_FILE = path.join(
  __dirname,
  "public/uploads/excel/20260513_RP ESG Utility Dashboard_Raw Data_2022-2026.xlsx"
);

// Convert Excel serial date number to { year, month }
function serialToYearMonth(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// Parse a flat sheet (Year | Month-serial | ...data cols)
// Returns array of { year, month, billMonth, row }
function parseRows(sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  let currentYear = null;
  const out = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (r[0] !== null && r[0] !== undefined) currentYear = Number(r[0]);
    if (!currentYear || !r[1]) continue;
    const { year, month } = serialToYearMonth(Number(r[1]));
    const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;
    out.push({ year: currentYear, month, billMonth, row: r });
  }
  return out;
}

async function main() {
  const xlsxPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;
  const accountId = Number(process.argv[3] || 1);

  console.log(`Importing: ${xlsxPath}`);
  console.log(`Account ID: ${accountId}`);

  const wb = XLSX.readFile(xlsxPath);
  const required = ["Elec", "Solar", "Water", "Waste"];
  for (const name of required) {
    if (!wb.Sheets[name]) throw new Error(`Missing sheet: "${name}"`);
  }

  const elecRows  = parseRows(wb.Sheets["Elec"]);
  const waterRows = parseRows(wb.Sheets["Water"]);
  const solarRows = parseRows(wb.Sheets["Solar"]);
  const wasteRows = parseRows(wb.Sheets["Waste"]);

  const yearsSet = new Set(elecRows.map((r) => r.year));

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 10000,
  });

  try {
    await conn.beginTransaction();

    // Clear total-level tables only; leave building_ebills / building_waterusage intact
    for (const t of ["total_ebills", "total_waterusage", "total_solardata", "total_wastedata", "year_range"]) {
      await conn.query(`DELETE FROM ${t} WHERE account_id = ?`, [accountId]);
    }

    // Year range
    for (const year of [...yearsSet].sort((a, b) => a - b)) {
      await conn.query("INSERT INTO year_range (account_id, year) VALUES (?, ?)", [accountId, year]);
    }

    // Electricity → RP Net Usage (col index 4)
    for (const { billMonth, row } of elecRows) {
      const rpNet = Number(row[4]) || 0;
      await conn.query(
        "INSERT INTO total_ebills (account_id, bill_month, total_bill) VALUES (?, ?, ?)",
        [accountId, billMonth, rpNet]
      );
    }

    // Water → Portable (col 2) + NEWater (col 3)
    for (const { billMonth, row } of waterRows) {
      const portable = Number(row[2]) || 0;
      const newater  = Number(row[3]) || 0;
      await conn.query(
        "INSERT INTO total_waterusage (account_id, bill_month, portable_water, recycled_water) VALUES (?, ?, ?, ?)",
        [accountId, billMonth, portable, newater]
      );
    }

    // Solar → single column (col 2) into urban_renewables; green_house = 0
    for (const { billMonth, row } of solarRows) {
      const solar = Number(row[2]) || 0;
      await conn.query(
        "INSERT INTO total_solardata (account_id, bill_month, urban_renewables, green_house) VALUES (?, ?, ?, 0)",
        [accountId, billMonth, solar]
      );
    }

    // Waste → general_kg (col 2); no recyclable or percent data
    for (const { billMonth, row } of wasteRows) {
      const generalKg = Number(row[2]) || 0;
      await conn.query(
        `INSERT INTO total_wastedata
           (account_id, bill_month, general_kg, recyclable_kg, general_percent, recyclable_percent)
         VALUES (?, ?, ?, 0, 0, 0)`,
        [accountId, billMonth, generalKg]
      );
    }

    await conn.commit();

    console.log(`Years imported : ${[...yearsSet].sort().join(", ")}`);
    console.log(`Electricity    : ${elecRows.length} rows`);
    console.log(`Water          : ${waterRows.length} rows`);
    console.log(`Solar          : ${solarRows.length} rows`);
    console.log(`Waste          : ${wasteRows.length} rows`);
    console.log("Import complete.");
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("IMPORT_FAILED:", err.message);
  process.exit(1);
});
