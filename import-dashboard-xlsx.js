require("dotenv").config({ path: "./databaseinfo.env" });

const path = require("path");
const XLSX = require("xlsx");
const mysql = require("mysql2/promise");

const DEFAULT_FILE = path.join(
  __dirname,
  "public/uploads/excel/1769019032795-20250917_RP Utility Dashboard_Raw Data_v1.xlsx"
);

function BuildingNameStandardized(name) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) return "";

  const upper = cleanName.toUpperCase();
  if (upper === "SPORT HALL" || upper === "SPORTS COMPLEX") return "Sports Complex";
  if (upper === "GREEN HOUSE" || upper === "GREENHOUSE") return "Green House";
  if (upper === "THE ARCH" || upper === "THE ARCH (1&2)" || upper.startsWith("THE ARCH")) return "The Arch";
  if (upper === "SIT" || upper === "BLK 43" || upper === "BLOCK 43") return "Blk 43";
  if (/^E[1-6]\b/.test(upper)) return upper.slice(0, 2);
  if (/^W[1-6]\b/.test(upper)) return upper.slice(0, 2);
  return cleanName;
}

async function main() {
  const xlsxPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;
  const accountId = Number(process.argv[3] || 1);

  console.log(`Importing workbook: ${xlsxPath}`);
  console.log(`Target account_id: ${accountId}`);

  const workbook = XLSX.readFile(xlsxPath);
  if (workbook.SheetNames.length < 6) {
    throw new Error("Workbook must contain at least 6 sheets");
  }

  const [sheet1, sheet2, sheet3, sheet4, sheet5, sheet6] = workbook.SheetNames.map((name) => workbook.Sheets[name]);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 10000,
  });

  const buildingNameSet = new Set();
  const detectedYears = new Set();
  const buildingElecYears = new Map();
  const buildingWaterYears = new Map();

  try {
    let yearRowIndex = 3;
    while (true) {
      const cell = sheet1[`B${yearRowIndex}`];
      if (!cell || cell.v === undefined || cell.v === null || String(cell.v).trim() === "") break;
      const yearValue = Number(cell.v);
      if (!Number.isFinite(yearValue) || yearValue < 2000 || yearValue > 2100) break;
      detectedYears.add(yearValue);
      yearRowIndex += 12;
    }

    const yearsArray = Array.from(detectedYears).sort((a, b) => a - b);
    if (yearsArray.length === 0) throw new Error("No valid years found in workbook");

    await conn.beginTransaction();

    const tables = [
      "total_ebills",
      "building_ebills",
      "total_waterusage",
      "building_waterusage",
      "total_solardata",
      "total_wastedata",
      "year_range",
    ];

    for (const table of tables) {
      await conn.query(`DELETE FROM ${table} WHERE account_id = ?`, [accountId]);
    }

    for (const year of yearsArray) {
      await conn.query("INSERT INTO year_range (account_id, year) VALUES (?, ?)", [accountId, year]);
    }

    for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
      const year = yearsArray[yearIndex];
      const startRow = 3 + yearIndex * 12;
      for (let month = 1; month <= 12; month++) {
        const dataRow = startRow + (month - 1);
        const billValue = sheet1[`D${dataRow}`] ? Number(sheet1[`D${dataRow}`].v) || 0 : 0;
        const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;
        await conn.query("INSERT INTO total_ebills (account_id, bill_month, total_bill) VALUES (?, ?, ?)", [accountId, billMonth, billValue]);
      }
    }

    for (let colIndex = 2; colIndex <= 23; colIndex++) {
      const col = XLSX.utils.encode_col(colIndex);
      const buildingName = BuildingNameStandardized(sheet2[`${col}4`]?.v);
      if (!buildingName) continue;
      buildingNameSet.add(buildingName);
      if (!buildingElecYears.has(buildingName)) buildingElecYears.set(buildingName, new Set());

      for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
        const year = yearsArray[yearIndex];
        const startRow = 5 + yearIndex * 15;
        let hasAnyData = false;
        for (let month = 1; month <= 12; month++) {
          const dataRow = startRow + (month - 1);
          const billValue = sheet2[`${col}${dataRow}`] ? Number(sheet2[`${col}${dataRow}`].v) || 0 : 0;
          const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;
          if (billValue > 0) hasAnyData = true;
          await conn.query(
            "INSERT INTO building_ebills (account_id, building_name, bill_month, bill_amount) VALUES (?, ?, ?, ?)",
            [accountId, buildingName, billMonth, billValue]
          );
        }
        if (hasAnyData) buildingElecYears.get(buildingName).add(year);
      }
    }

    for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
      const year = yearsArray[yearIndex];
      const startRow = 3 + yearIndex * 12;
      for (let month = 1; month <= 12; month++) {
        const dataRow = startRow + (month - 1);
        const potable = sheet3[`D${dataRow}`] ? Number(sheet3[`D${dataRow}`].v) || 0 : 0;
        const recycled = sheet3[`E${dataRow}`] ? Number(sheet3[`E${dataRow}`].v) || 0 : 0;
        const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;
        await conn.query(
          "INSERT INTO total_waterusage (account_id, bill_month, portable_water, recycled_water) VALUES (?, ?, ?, ?)",
          [accountId, billMonth, potable, recycled]
        );
      }
    }

    function extractYearFromCY(cellValue) {
      const match = String(cellValue || "").trim().toUpperCase().match(/CY(\d{4})/i);
      return match ? Number(match[1]) : null;
    }

    const startingYear = extractYearFromCY(sheet4["B2"]?.v);
    if (!startingYear) throw new Error("Tab 4 invalid year format in B2");

    const tab4Buildings = [];
    for (let colIndex = 2; colIndex <= 21; colIndex++) {
      const col = XLSX.utils.encode_col(colIndex);
      const buildingName = BuildingNameStandardized(sheet4[`${col}3`]?.v);
      if (!buildingName) continue;
      tab4Buildings.push({ col, name: buildingName });
      buildingNameSet.add(buildingName);
      if (!buildingWaterYears.has(buildingName)) buildingWaterYears.set(buildingName, new Set());
    }

    let yearBlocks = [];
    let currentYear = startingYear;
    for (let blockIndex = 0; blockIndex < 10; blockIndex++) {
      const startRow = 4 + blockIndex * 15;
      let hasData = false;
      for (let testCol = 2; testCol <= 5 && !hasData; testCol++) {
        const col = XLSX.utils.encode_col(testCol);
        for (let testRow = startRow; testRow < startRow + 3; testRow++) {
          const cell = sheet4[`${col}${testRow}`];
          if (cell && cell.v !== undefined && cell.v !== null && Number(cell.v) > 0) {
            hasData = true;
            break;
          }
        }
      }
      if (!hasData) break;
      yearBlocks.push({ year: currentYear, startRow });
      currentYear++;
    }

    for (const building of tab4Buildings) {
      for (const yearBlock of yearBlocks) {
        let hasAnyData = false;
        for (let month = 1; month <= 12; month++) {
          const dataRow = yearBlock.startRow + (month - 1);
          const waterUsed = sheet4[`${building.col}${dataRow}`] ? Number(sheet4[`${building.col}${dataRow}`].v) || 0 : 0;
          const billMonth = `${yearBlock.year}-${String(month).padStart(2, "0")}-01`;
          if (waterUsed > 0) hasAnyData = true;
          await conn.query(
            "INSERT INTO building_waterusage (account_id, building_name, bill_month, water_used) VALUES (?, ?, ?, ?)",
            [accountId, building.name, billMonth, waterUsed]
          );
        }
        if (hasAnyData) buildingWaterYears.get(building.name).add(yearBlock.year);
      }
    }

    for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
      const year = yearsArray[yearIndex];
      const startRow = 3 + yearIndex * 12;
      for (let month = 1; month <= 12; month++) {
        const dataRow = startRow + (month - 1);
        const urbanRenewables = sheet5[`D${dataRow}`] ? Number(sheet5[`D${dataRow}`].v) || 0 : 0;
        const greenHouse = sheet5[`E${dataRow}`] ? Number(sheet5[`E${dataRow}`].v) || 0 : 0;
        const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;
        await conn.query(
          "INSERT INTO total_solardata (account_id, bill_month, urban_renewables, green_house) VALUES (?, ?, ?, ?)",
          [accountId, billMonth, urbanRenewables, greenHouse]
        );
      }
    }

    const fiscalMonthOrder = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
    const FY_LABEL_START_ROW = 7;
    const ROWS_PER_FY_BLOCK = 13;

    function parseFiscalYearLabel(cellValue) {
      const match = String(cellValue || "").trim().toUpperCase().match(/FY\s*(\d{2,4})/i);
      if (!match) return null;
      let year = Number(match[1]);
      if (year < 100) year += 2000;
      return year >= 2000 && year <= 2100 ? year : null;
    }

    for (let fyIndex = 0; fyIndex < 20; fyIndex++) {
      const labelRow = FY_LABEL_START_ROW + fyIndex * ROWS_PER_FY_BLOCK;
      const fyStartYear = parseFiscalYearLabel(sheet6[`A${labelRow}`]?.v);
      if (!fyStartYear) break;
      const dataStartRow = labelRow + 1;
      for (let i = 0; i < 12; i++) {
        const dataRow = dataStartRow + i;
        const calendarMonth = fiscalMonthOrder[i];
        const calendarYear = calendarMonth >= 4 ? fyStartYear : fyStartYear + 1;
        const billMonth = `${calendarYear}-${String(calendarMonth).padStart(2, "0")}-01`;
        const generalKg = sheet6[`B${dataRow}`] ? Number(sheet6[`B${dataRow}`].v) || 0 : 0;
        const recycleKg = sheet6[`C${dataRow}`] ? Number(sheet6[`C${dataRow}`].v) || 0 : 0;
        const generalPct = sheet6[`D${dataRow}`] ? Number(sheet6[`D${dataRow}`].v) || 0 : 0;
        const recyclePct = sheet6[`E${dataRow}`] ? Number(sheet6[`E${dataRow}`].v) || 0 : 0;
        await conn.query(
          `INSERT INTO total_wastedata (account_id, bill_month, general_kg, recyclable_kg, general_percent, recyclable_percent)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [accountId, billMonth, generalKg, recycleKg, generalPct, recyclePct]
        );
      }
    }

    if (buildingNameSet.size > 0) {
      const [existingRows] = await conn.query("SELECT id, building_name FROM building_info WHERE account_id = ?", [accountId]);
      const existingMap = new Map();
      (existingRows || []).forEach((row) => existingMap.set(BuildingNameStandardized(row.building_name), row.id));

      for (const name of buildingNameSet) {
        const elecYears = Array.from(buildingElecYears.get(name) || []).sort((a, b) => a - b);
        const waterYears = Array.from(buildingWaterYears.get(name) || []).sort((a, b) => a - b);
        const elecStart = elecYears[0] || null;
        const elecEnd = elecYears[elecYears.length - 1] || null;
        const waterStart = waterYears[0] || null;
        const waterEnd = waterYears[waterYears.length - 1] || null;
        const existingId = existingMap.get(name);

        if (existingId) {
          await conn.query(
            "UPDATE building_info SET elec_startyear = ?, elec_endyear = ?, water_startyear = ?, water_endyear = ? WHERE id = ?",
            [elecStart, elecEnd, waterStart, waterEnd, existingId]
          );
        } else {
          await conn.query(
            "INSERT INTO building_info (account_id, building_name, `desc`, filename, elec_startyear, elec_endyear, water_startyear, water_endyear) VALUES (?, ?, '', NULL, ?, ?, ?, ?)",
            [accountId, name, elecStart, elecEnd, waterStart, waterEnd]
          );
        }
      }
    }

    await conn.commit();
    console.log(`Imported years: ${yearsArray.join(", ")}`);
    console.log(`Imported buildings: ${buildingNameSet.size}`);
    console.log("Workbook import complete.");
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw error;
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error("IMPORT_FAILED:", error.message);
  process.exit(1);
});
