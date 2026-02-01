const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const app = express();
const RESET_PASSCODE = process.env.RESET_PASSCODE || "Reset@ESGDashboard!";

require('dotenv').config({ path: './databaseinfo.env' });

/* ==============================
   SESSION SETUP
============================== */
app.use(
  session({
    secret: "dev-key",
    resave: false,
    saveUninitialized: true,
  })
);

/* ==============================
   MULTER FILE UPLOAD SETUP
============================== */

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function makeUploaderFor(subFolder) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, "public", "uploads", subFolder);
      ensureDir(uploadDir);
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  });
  return multer({ storage });
}

const uploadExcel = makeUploaderFor("excel");
const uploadVideo = makeUploaderFor("videos");
const uploadCarouselImages = makeUploaderFor(path.join("images", "carousel"));
const uploadBuildingImages = makeUploaderFor(path.join("images", "Buildings"));

/* ==============================
   MYSQL CONNECTION
============================== */
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

connection.connect((err) => {
  if (err) {
    console.error('MySQL connection error:', err);
  } else {
    console.log('Connected to MySQL as', process.env.DB_USER);
  }
});

/* ==============================
   EXPRESS (BODY PARSING)
============================== */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const db = connection.promise();

/**
 * Helper: get "current account id"
 */
function getAccountId(req) {
  if (req.session && req.session.user && req.session.user.id) {
    return req.session.user.id;
  }
  return 1;
}

/* ==============================
   DYNAMIC YEAR MANAGEMENT FUNCTIONS
============================== */

/**
 * Check if year_range table exists
 */
async function yearRangeTableExists() {
  try {
    const [tables] = await db.query("SHOW TABLES LIKE 'year_range'");
    return tables && tables.length > 0;
  } catch (e) {
    console.error("Error checking year_range table:", e);
    return false;
  }
}

/**
 * Fetch all configured years for an account from year_range table
 * Returns: { allYears: [2024, 2023, 2022, ...], latestYear: 2024 }
 */
async function getYearsForAccount(accountId) {
  try {
    const tableExists = await yearRangeTableExists();
    if (!tableExists) {
      console.warn("WARNING: year_range table does not exist");
      return { allYears: [], latestYear: null };
    }

    const [rows] = await db.query(
      `SELECT DISTINCT year 
       FROM year_range 
       WHERE account_id = ? 
       ORDER BY year DESC`,
      [accountId]
    );

    if (!rows || rows.length === 0) {
      return { allYears: [], latestYear: null };
    }

    const allYears = rows.map(r => Number(r.year)).filter(y => Number.isFinite(y));
    const latestYear = allYears.length > 0 ? allYears[0] : null;

    return { allYears, latestYear };
  } catch (e) {
    console.error("Failed to fetch years from year_range:", e);
    return { allYears: [], latestYear: null };
  }
}
const multi_building_groups_by_page = {
  3: ["E1", "E2", "E3", "E4", "E5", "E6"],          
  4: ["W1", "W2", "W3", "W4", "W5", "W6"],          
  5: ["ECMC", "RPC", "TRCC", "Sports Complex", "The Arch", "Green House"],  
  6: ["BLK 43", "RPIC", "XLC", "ALC"],              
}

/**
 * Save detected years to year_range table
 */
async function saveYearsForAccount(accountId, yearsArray) {
  try {
    const tableExists = await yearRangeTableExists();
    if (!tableExists) {
      console.error("ERROR: year_range table does not exist. Please run migration.");
      return false;
    }

    await db.query("START TRANSACTION");
    await db.query("DELETE FROM year_range WHERE account_id = ?", [accountId]);

    const uniqueYears = [...new Set(yearsArray)];
    const insertSQL = "INSERT INTO year_range (account_id, year) VALUES (?, ?)";
    
    for (const year of uniqueYears) {
      const yearNum = Number(year);
      if (!Number.isFinite(yearNum)) continue;
      await db.query(insertSQL, [accountId, yearNum]);
    }

    await db.query("COMMIT");
    console.log(`Saved ${uniqueYears.length} years for account ${accountId}:`, uniqueYears);
    return true;
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("Failed to save years:", e);
    return false;
  }
}

/* ==============================
   BUILDING NAME HELPERS
   (Moved up before getBuildingYearRanges since it uses normalizeBuildingKey)
============================== */

function BuildingNameStandardized(name) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) return "";

  const upper = cleanName.toUpperCase();

  if (upper === "SPORT HALL" || upper === "SPORTS COMPLEX") return "Sports Complex";
  if (upper === "GREEN HOUSE" || upper === "GREENHOUSE") return "Green House";

  if (upper === "THE ARCH" || upper === "THE ARCH (1&2)" || upper.startsWith("THE ARCH")) {
    return "The Arch";
  }

  if (upper === "SIT" || upper === "BLK 43" || upper === "BLOCK 43") return "Blk 43";

  if (/^E[1-6]\b/.test(upper)) return upper.slice(0, 2);
  if (/^W[1-6]\b/.test(upper)) return upper.slice(0, 2);

  return cleanName;
}

function normalizeBuildingKey(name) {
  if (!name) return "";
  const raw = String(name).trim();
  const upper = raw.toUpperCase();

  if (/^E[1-6]\b/.test(upper)) return upper.slice(0, 2);
  if (/^W[1-6]\b/.test(upper)) return upper.slice(0, 2);

  if (upper === "SPORT HALL" || upper === "SPORTS COMPLEX") return "SPORTS COMPLEX";
  if (upper.indexOf("GREEN HOUSE") !== -1 || upper === "GREENHOUSE") return "GREEN HOUSE";

  if (
    upper === "THE ARCH" ||
    upper === "THE ARCH (1&2)" ||
    upper === "THE ARCH " ||
    upper.indexOf("THE ARCH") === 0
  )
    return "THE ARCH";

  if (upper === "RPIC" || upper === "RIPC") return "RPIC";
  if (upper === "BLK 43" || upper === "BLOCK 43" || upper === "SIT") return "BLK 43";

  return upper;
}

function buildingDisplayLabelFromKey(key) {
  switch (key) {
    case "E3": return "E3";
    case "W4": return "W4";
    case "SPORTS COMPLEX": return "Sports Complex";
    case "THE ARCH": return "The Arch";
    case "GREEN HOUSE": return "Green House";
    case "BLK 43": return "Blk 43";
    case "RPIC": return "RPIC";
    default: return key;
  }
}

function getBuildingNameVariants(name) {
  const key = BuildingNameStandardized(name);

  switch (key) {
    case "E3":
      return ["E3", "E3 (incl Agora Library)", "E3 (incl Agora Hall)", "E3 incl Agora Hall"];
    case "W4":
      return ["W4", "W4, Agora Hall", "W4 Agora Hall", "W4 (Agora Hall)"];
    case "Sports Complex":
      return ["Sports Complex", "SPORT HALL", "SPORTS COMPLEX"];
    case "The Arch":
      return ["The Arch", "The Arch (1&2)", "THE ARCH", "THE ARCH (1&2)"];
    case "Green House":
      return ["Green House", "GREEN HOUSE", "GREENHOUSE"];
    case "Blk 43":
      return ["Blk 43", "BLK 43", "BLOCK 43", "SIT"];
    case "RPIC":
      return ["RPIC", "RIPC"];
    default:
      return [name];
  }
}

function buildingRawNameFromSlug(slug) {
  const slugMap = {
    "e1": "E1", "e2": "E2", "e3": "E3", "e4": "E4", "e5": "E5", "e6": "E6",
    "w1": "W1", "w2": "W2", "w3": "W3", "w4": "W4", "w5": "W5", "w6": "W6",
    "sports-complex": "Sports Complex",
    "the-arch": "The Arch",
    "green-house": "Green House",
    "blk-43": "Blk 43",
    "rpic": "RPIC",
    "ecmc": "ECMC",
    "rpc": "RPC",
    "trcc": "TRCC",
    "xlc": "XLC",
    "alc": "ALC"
  };
  return slugMap[slug.toLowerCase()] || slug;
}

function infoSlugFromBuildingRawName(name) {
  const raw = String(name || "").trim();
  const key = normalizeBuildingKey(raw);
  
  const slugMap = {
    "E1": "e1", "E2": "e2", "E3": "e3", "E4": "e4", "E5": "e5", "E6": "e6",
    "W1": "w1", "W2": "w2", "W3": "w3", "W4": "w4", "W5": "w5", "W6": "w6",
    "SPORTS COMPLEX": "sports-complex",
    "THE ARCH": "the-arch",
    "GREEN HOUSE": "green-house",
    "BLK 43": "blk-43",
    "RPIC": "rpic",
    "ECMC": "ecmc",
    "RPC": "rpc",
    "TRCC": "trcc",
    "XLC": "xlc",
    "ALC": "alc"
  };
  return slugMap[key] || raw.toLowerCase().replace(/\s+/g, "-");
}

/* ==============================
   BUILDING YEAR RANGE FUNCTIONS
============================== */

/**
 * Fetch building-specific year ranges from building_info
 * Returns: { 
 *   buildingKey: { 
 *     elecStartYear, elecEndYear, 
 *     waterStartYear, waterEndYear,
 *     buildingName 
 *   }, ... 
 * }
 */
async function getBuildingYearRanges(accountId) {
  try {
    const [rows] = await db.query(
      `SELECT building_name, 
              elec_startyear, elec_endyear, 
              water_startyear, water_endyear
       FROM building_info 
       WHERE account_id = ?`,
      [accountId]
    );

    const yearRanges = {};
    
    (rows || []).forEach((row) => {
      const buildingKey = normalizeBuildingKey(row.building_name);
      if (!buildingKey) return;
      
      // Parse electricity year range
      const elecStart = row.elec_startyear ? Number(row.elec_startyear) : null;
      const elecEnd = row.elec_endyear ? Number(row.elec_endyear) : null;
      
      // Parse water year range
      const waterStart = row.water_startyear ? Number(row.water_startyear) : null;
      const waterEnd = row.water_endyear ? Number(row.water_endyear) : null;
      
      yearRanges[buildingKey] = {
        elecStartYear: Number.isFinite(elecStart) ? elecStart : null,
        elecEndYear: Number.isFinite(elecEnd) ? elecEnd : null,
        waterStartYear: Number.isFinite(waterStart) ? waterStart : null,
        waterEndYear: Number.isFinite(waterEnd) ? waterEnd : null,
        buildingName: row.building_name
      };
    });

    return yearRanges;
  } catch (e) {
    console.error("Failed to fetch building year ranges:", e);
    return {};
  }
}

/**
 * Get valid years for a specific building based on its year range
 * @param {Array} allYears - All available years
 * @param {string} buildingKey - Normalized building key
 * @param {Object} buildingYearRanges - Year ranges object from getBuildingYearRanges
 * @param {string} dataType - 'electricity' or 'water'
 * @returns {Array} Filtered years valid for this building and data type
 */
function getValidYearsForBuilding(allYears, buildingKey, buildingYearRanges, dataType = 'electricity') {
  const ranges = buildingYearRanges[buildingKey];
  
  if (!ranges) {
    return allYears;
  }
  
  let startYear, endYear;
  
  if (dataType === 'water') {
    startYear = ranges.waterStartYear;
    endYear = ranges.waterEndYear;
  } else {
    startYear = ranges.elecStartYear;
    endYear = ranges.elecEndYear;
  }
  
  if (!startYear && !endYear) {
    return allYears;
  }
  
  return allYears.filter(year => {
    if (startYear && year < startYear) return false;
    if (endYear && year > endYear) return false;
    return true;
  });
}

/**
 * Get valid electricity years for a building
 */
function getValidElecYearsForBuilding(allYears, buildingKey, buildingYearRanges) {
  return getValidYearsForBuilding(allYears, buildingKey, buildingYearRanges, 'electricity');
}

/**
 * Get valid water years for a building
 */
function getValidWaterYearsForBuilding(allYears, buildingKey, buildingYearRanges) {
  return getValidYearsForBuilding(allYears, buildingKey, buildingYearRanges, 'water');
}

/* ==============================
   MEDIA HELPERS
============================== */

async function getNextMediaSortOrder(accountId, mediaType) {
  const [rows] = await db.query(
    "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM dashboard_media WHERE account_id = ? AND media_type = ?",
    [accountId, mediaType]
  );
  const maxOrder = rows && rows[0] ? Number(rows[0].maxOrder || 0) : 0;
  return maxOrder + 1;
}

/* ==============================
   ADMIN ROUTES
============================== */

app.post("/admin/dashboard-mode", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized - Please login.");

  const accountId = req.session.user.id;
  const mode = String(req.body.dashboard_mode || "auto").toLowerCase();

  try {
    await db.query(
      "UPDATE accounts SET dashboard_mode = ? WHERE id = ?",
      [mode, accountId]
    );
    res.redirect("/admin#sec-dashboard-mode");
  } catch (err) {
    console.error("Error saving dashboard mode:", err);
    res.status(500).send("Failed to save dashboard mode");
  }
});

// POST /admin/timers/:timer_id - Update timer duration
app.post('/admin/timers/:timer_id', requireAuth, async (req, res) => {
  try {
    const { timer_id } = req.params;
    const { duration_seconds } = req.body;
    
    // Validate timer_id
    if (!timer_id) {
      return res.status(400).send("Missing timer_id");
    }
    
    // Validate duration_seconds input
    const seconds = parseInt(duration_seconds, 10);
    if (isNaN(seconds) || seconds < 0 || seconds > 5999) {
      return res.status(400).send("Invalid duration. Must be 0-5999 seconds.");
    }

    // Get account_id from session (check multiple possible locations)
    const accountId = req.session.user?.id || req.session.user?.account_id || req.session.account_id;

    // Validate account_id exists
    if (!accountId) {
      console.error("No account_id found in session:", req.session);
      return res.status(401).send("Unauthorized - no account found");
    }

    // Update the timers table with account_id check
    const [result] = await db.query(
      `UPDATE timers 
       SET duration_seconds = ? 
       WHERE timer_id = ? AND account_id = ?`,
      [seconds, timer_id, accountId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).send("Timer not found.");
    }
    
    console.log(`Timer ${timer_id} updated to ${seconds} seconds for account ${accountId}`);
    res.status(200).send("Timer updated successfully");
    
  } catch (error) {
    console.error("Error updating timer:", error);
    res.status(500).send("Failed to update timer");
  }
});

app.post("/admin/building-description",
  uploadBuildingImages.single("imgfile"),
  async (req, res) => {
    if (!req.session.user) {
      return res.status(401).send("Unauthorized - Please login.");
    }

    const accountId = req.session.user.id;
    const buildingId = Number(req.body.building_id || 0);
    const desc = String(req.body.description || "").trim();

    if (!buildingId) {
      return res.status(400).send("Invalid building id");
    }

    if (!desc) {
      return res.status(400).send("Description cannot be empty");
    }

    try {
      const [rows] = await db.query(
        "SELECT id FROM building_info WHERE account_id = ? AND id = ? LIMIT 1",
        [accountId, buildingId]
      );

      if (!rows || !rows.length) {
        return res.status(400).send("Unable to display building info (missing record).");
      }

      if (req.file && req.file.filename) {
        await db.query(
          `UPDATE building_info
           SET \`desc\` = ?, filename = ?
           WHERE account_id = ? AND id = ?`,
          [desc, req.file.filename, accountId, buildingId]
        );
      } else {
        await db.query(
          `UPDATE building_info
           SET \`desc\` = ?
           WHERE account_id = ? AND id = ?`,
          [desc, accountId, buildingId]
        );
      }

      return res.redirect("/admin#sec-building-description");
    } catch (err) {
      console.error("Failed to save building description:", err);
      return res.status(500).send("Failed to save building description.");
    }
  }
);
/* ==============================
   ADMIN: SAVE BUILDING LABELS
============================== */
app.post("/admin/building-labels", requireAuth, async (req, res) => {
  const accountId = req.session.user.id;
  const { labels, card_labels } = req.body;

  try {
    // Get all buildings for this account
    const [buildings] = await db.query(
      "SELECT id FROM building_info WHERE account_id = ?",
      [accountId]
    );

    // Update each building's labels
    for (const building of buildings) {
      const buildingId = building.id;
      
      const displayLabel = labels?.[buildingId] || null;
      const cardLabel = card_labels?.[buildingId] || null;

      await db.query(
        `UPDATE building_info 
         SET display_label = ?, card_label = ? 
         WHERE id = ? AND account_id = ?`,
        [displayLabel, cardLabel, buildingId, accountId]
      );
    }

    console.log(`Updated labels for ${buildings.length} buildings (account ${accountId})`);
    res.redirect("/admin#sec-building-description");

  } catch (error) {
    console.error("Error saving building labels:", error);
    res.status(500).send("Failed to save building labels");
  }
});

/* ==============================
   DATA LOAD HELPERS
============================== */

async function getOverviewByBuilding(accountId, year) {
  if (!year) return [];

  const electricSql = `
    SELECT TRIM(building_name) AS building, SUM(bill_amount) AS total
    FROM building_ebills
    WHERE account_id = ? AND YEAR(bill_month) = ?
    GROUP BY TRIM(building_name)
  `;

  const waterSql = `
    SELECT TRIM(building_name) AS building, SUM(water_used) AS total
    FROM building_waterusage
    WHERE account_id = ? AND YEAR(bill_month) = ?
    GROUP BY TRIM(building_name)
  `;

  const [elecRows] = await db.query(electricSql, [accountId, year]);
  const [waterRows] = await db.query(waterSql, [accountId, year]);

  const buildingMap = {};

  elecRows.forEach((row) => {
    const key = BuildingNameStandardized(row.building);
    if (!key) return;
    if (!buildingMap[key]) {
      buildingMap[key] = { building: key, electricity: 0, water: 0 };
    }
    buildingMap[key].electricity += Number(row.total || 0);
  });

  waterRows.forEach((row) => {
    const key = BuildingNameStandardized(row.building);
    if (!key) return;
    if (!buildingMap[key]) {
      buildingMap[key] = { building: key, electricity: 0, water: 0 };
    }
    buildingMap[key].water += Number(row.total || 0);
  });

  return Object.values(buildingMap).sort((a, b) =>
    String(a.building).localeCompare(String(b.building))
  );
}

async function getSolarForYear(accountId, year) {
  if (!year) return [];

  const sql = `
    SELECT MONTH(bill_month) AS m, urban_renewables, green_house
    FROM total_solardata
    WHERE account_id = ? AND YEAR(bill_month) = ?
    ORDER BY bill_month
  `;

  const [rows] = await db.query(sql, [accountId, year]);

  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    urban: 0,
    greenhouse: 0,
  }));

  rows.forEach((row) => {
    const monthIndex = row.m - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      months[monthIndex].urban = Number(row.urban_renewables || 0);
      months[monthIndex].greenhouse = Number(row.green_house || 0);
    }
  });

  return months;
}

async function getWasteForFiscalYear(accountId, fyStartYear) {
  if (!fyStartYear) return [];

  const sql = `
    SELECT 
      YEAR(bill_month) AS y, 
      MONTH(bill_month) AS m,
      SUM(general_kg) AS generalKg,
      SUM(recyclable_kg) AS recyclableKg
    FROM total_wastedata
    WHERE account_id = ?
      AND (
        (YEAR(bill_month) = ? AND MONTH(bill_month) >= 4) OR
        (YEAR(bill_month) = ? AND MONTH(bill_month) <= 3)
      )
    GROUP BY y, m
    ORDER BY y, m
  `;

  const [rows] = await db.query(sql, [accountId, fyStartYear, fyStartYear + 1]);

  const monthlyWaste = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    generalKg: 0,
    recyclableKg: 0,
  }));

  rows.forEach((row) => {
    const y = Number(row.y);
    const m = Number(row.m);
    let fiscalIndex = null;

    if (y === fyStartYear && m >= 4) {
      fiscalIndex = m - 4 + 1;
    } else if (y === fyStartYear + 1 && m <= 3) {
      fiscalIndex = m + 9;
    } else {
      return;
    }

    const fiscalArrayIndex = fiscalIndex - 1;
    monthlyWaste[fiscalArrayIndex].generalKg = Number(row.generalKg || 0);
    monthlyWaste[fiscalArrayIndex].recyclableKg = Number(row.recyclableKg || 0);
  });

  return monthlyWaste;
}

async function getBuildingMonthlyDetail(accountId, year, buildingNameRaw) {
  if (!year || !buildingNameRaw) return null;

  const buildingName = BuildingNameStandardized(buildingNameRaw);
  if (!buildingName) return null;

  const variants = getBuildingNameVariants(buildingName);
  const whereClause = variants.map(() => "TRIM(building_name) = TRIM(?)").join(" OR ");

  const electricSql = `
    SELECT MONTH(bill_month) AS m, SUM(bill_amount) AS total
    FROM building_ebills
    WHERE account_id = ? AND YEAR(bill_month) = ?
      AND (${whereClause})
    GROUP BY m
  `;

  const waterSql = `
    SELECT MONTH(bill_month) AS m, SUM(water_used) AS total
    FROM building_waterusage
    WHERE account_id = ? AND YEAR(bill_month) = ?
      AND (${whereClause})
    GROUP BY m
  `;

  const params = [accountId, year, ...variants];

  const [electricRows] = await db.query(electricSql, params);
  const [waterRows] = await db.query(waterSql, params);

  const elec = Array(12).fill(0);
  const water = Array(12).fill(0);

  electricRows.forEach((row) => {
    const idx = Number(row.m) - 1;
    if (idx >= 0 && idx < 12) elec[idx] = Number(row.total || 0);
  });

  waterRows.forEach((row) => {
    const idx = Number(row.m) - 1;
    if (idx >= 0 && idx < 12) water[idx] = Number(row.total || 0);
  });

  return { year, elec, water, building: buildingName };
}

/* ==============================
   VIEW ENGINE & STATIC FILES
============================== */
app.set("view engine", "ejs");
app.use(express.static("public"));
app.set('view cache', false);



async function getDashboardModeForAccount(accountId) {
  try {
    const [rows] = await db.query("SELECT dashboard_mode FROM accounts WHERE id = ?", [accountId]);
    const mode = rows && rows[0] && rows[0].dashboard_mode ? String(rows[0].dashboard_mode) : "auto";
    return mode.toLowerCase() === "interactive" ? "interactive" : "auto";
  } catch (e) {
    return "auto";
  }
}

/* ==============================
   HOME PAGE
============================== */

app.get("/", async (req, res) => {
  const accountId = getAccountId(req);

  const queryMode = req.query.mode ? String(req.query.mode).toLowerCase() : null;
  const dbMode = await getDashboardModeForAccount(accountId);
  const effectiveMode =
    queryMode === "interactive" ? "interactive" : (queryMode === "auto" ? "auto" : dbMode);
  const dashboardMode = effectiveMode;

  let timers = [];
  let timersByTimerId = {};

  try {
    const years = await getYearsForAccount(accountId);
    const { allYears, latestYear } = years;

    const oldestYear = allYears.length > 0 ? allYears[allYears.length - 1] : null;
    const newestYear = latestYear;

    const buildingYearRanges = await getBuildingYearRanges(accountId);

    // Fetch overview data for ALL years
    const overviewByYear = {};
    for (const year of allYears) {
      const rows = await getOverviewByBuilding(accountId, year);
      overviewByYear[year] = rows;
    }

    let overviewOldestRows = [];
    let overviewNewestRows = [];
    
    if (oldestYear && overviewByYear[oldestYear]) {
      overviewOldestRows = overviewByYear[oldestYear];
    }
    if (newestYear && overviewByYear[newestYear]) {
      overviewNewestRows = overviewByYear[newestYear];
    }

    // Fetch solar data for ALL years
    const solarByYear = {};
    for (const year of allYears) {
      const months = await getSolarForYear(accountId, year);
      solarByYear[year] = months;
    }

    let solarOldestMonths = [];
    let solarNewestMonths = [];
    
    if (oldestYear && solarByYear[oldestYear]) {
      solarOldestMonths = solarByYear[oldestYear];
    }
    if (newestYear && solarByYear[newestYear]) {
      solarNewestMonths = solarByYear[newestYear];
    }

    // Fetch waste data for ALL years
    const wasteByYear = {};
    for (const year of allYears) {
      const months = await getWasteForFiscalYear(accountId, year);
      wasteByYear[year] = months;
    }

    let wasteOldestMonths = [];
    let wasteNewestMonths = [];
    
    if (oldestYear && wasteByYear[oldestYear]) {
      wasteOldestMonths = wasteByYear[oldestYear];
    }
    if (newestYear && wasteByYear[newestYear]) {
      wasteNewestMonths = wasteByYear[newestYear];
    }

    // Building monthly data
    const buildingMonthly = {};
    const buildingMonthlyByYear = {};

    if (latestYear) {
      const buildingCodeSet = new Set();
      Object.values(multi_building_groups_by_page).forEach((list) => {
        list.forEach((code) => buildingCodeSet.add(code));
      });

      for (const buildingCode of buildingCodeSet) {
        const buildingKey = normalizeBuildingKey(buildingCode);
        
        const validElecYears = getValidElecYearsForBuilding(allYears, buildingKey, buildingYearRanges);
        const validWaterYears = getValidWaterYearsForBuilding(allYears, buildingKey, buildingYearRanges);
        const allValidYears = [...new Set([...validElecYears, ...validWaterYears])].sort((a, b) => a - b);
        
        if (validElecYears.includes(latestYear) || validWaterYears.includes(latestYear)) {
          const detail = await getBuildingMonthlyDetail(accountId, latestYear, buildingCode);
          if (detail) {
            buildingMonthly[buildingKey] = detail;
          }
        }

        const dataByYear = {};
        for (const year of allValidYears) {
          try {
            const detail = await getBuildingMonthlyDetail(accountId, year, buildingCode);
            if (detail) {
              dataByYear[year] = detail;
            }
          } catch (e) {
            console.error(`Error fetching building data for ${buildingCode} year ${year}:`, e);
          }
        }

        buildingMonthlyByYear[buildingKey] = {
          dataByYear: dataByYear,
          validYears: allValidYears,
          validElecYears: validElecYears,
          validWaterYears: validWaterYears
        };
      }
    }

    // Media
    let mediaImages = [];
    let mediaVideos = [];
    try {
      const [imgRows] = await db.query(
        "SELECT * FROM dashboard_media WHERE account_id = ? AND media_type = 'image' AND is_enabled = 1 ORDER BY sort_order ASC, id ASC",
        [accountId]
      );
      const [vidRows] = await db.query(
        "SELECT * FROM dashboard_media WHERE account_id = ? AND media_type = 'video' AND is_enabled = 1 ORDER BY sort_order ASC, id ASC",
        [accountId]
      );
      mediaImages = imgRows || [];
      mediaVideos = vidRows || [];
    } catch (e) {
      console.error("Failed to load media:", e);
      mediaImages = [];
      mediaVideos = [];
    }

    // ============================================================
    // TIMERS - Fetch using timer_id (1-10)
    // ============================================================
    try {
      const [tables] = await db.query("SHOW TABLES LIKE 'timers'");
      
      if (tables && tables.length > 0) {
        const [timerRows] = await db.query(
          `SELECT timer_id, page_name, duration_seconds 
           FROM timers 
           WHERE account_id = ? 
           ORDER BY timer_id ASC`,
          [accountId]
        );
        
        if (Array.isArray(timerRows)) {
          timers = timerRows;
          
          // Build timersByTimerId map keyed by timer_id (1-10)
          timers.forEach(t => {
            const timerId = parseInt(t.timer_id, 10);
            const durationSeconds = Number(t.duration_seconds) || 30;
            
            if (!isNaN(timerId) && timerId >= 1 && timerId <= 10) {
              timersByTimerId[timerId] = {
                timer_id: timerId,
                page_name: t.page_name || `Page ${timerId}`,
                duration_seconds: durationSeconds,
                duration_ms: durationSeconds * 1000
              };
            }
          });
        }
        
        console.log(`Loaded ${timers.length} timers for account ${accountId}:`, timersByTimerId);
      } else {
        console.log("Timers table does not exist, using defaults");
      }
    } catch (e) {
      console.error("Failed to load timers (non-fatal):", e.message);
    }

    // Building labels
    const buildingLabelMap = {};
    try {
      const [rows] = await db.query(
        "SELECT building_name, display_label FROM building_info WHERE account_id = ?",
        [accountId]
      );
      (rows || []).forEach((r) => {
        const key = normalizeBuildingKey(r.building_name);
        if (!key) return;
        const lbl = String(r.display_label || "").trim();
        if (lbl) buildingLabelMap[key] = lbl;
      });
    } catch (e) {
      console.error("Failed to load building display labels:", e);
    }

    const buildingCardLabelMap = {};
    try {
      const [cardLabelRows] = await db.query(
        "SELECT building_name, card_label FROM building_info WHERE account_id = ? AND card_label IS NOT NULL AND card_label != ''",
        [accountId]
      );
      (cardLabelRows || []).forEach((r) => {
        const key = normalizeBuildingKey(r.building_name);
        if (!key) return;
        const cardLabel = String(r.card_label || "").trim();
        if (cardLabel) buildingCardLabelMap[key] = cardLabel;
      });
    } catch (e) {
      console.error("Failed to load building card labels:", e);
    }

    // Dashboard data
    const dashboardData = {
      allYears,
      latestYear,
      oldestYear,
      newestYear,
      overviewByYear,
      solarByYear,
      wasteByYear,
      overviewYear1Rows: overviewOldestRows,
      overviewYear2Rows: overviewNewestRows,
      solarYear1Months: solarOldestMonths,
      solarYear2Months: solarNewestMonths,
      wasteYear1Months: wasteOldestMonths,
      wasteYear2Months: wasteNewestMonths,
      buildingMonthly,
      buildingMonthlyByYear,
      buildingYearRanges
    };

    res.render("index", {
      user: req.session.user || null,
      dashboardData,
      dashboardMode,
      mediaImages,
      mediaVideos,
      buildingLabelMap,
      buildingCardLabelMap,
      timers: timers || [],
      timersByTimerId: timersByTimerId || {}
    });
  } catch (err) {
    console.error("Error loading dashboard:", err);
    res.status(500).send("Internal Server Error");
  }
});



/* ==============================
   BUILDING CONTROLS
============================== */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).send("Unauthorized - Please login.");
  next();
}

app.get("/buildingControls", async (req, res) => {
  const accountId = getAccountId(req);

  const queryMode = req.query.mode ? String(req.query.mode).toLowerCase() : null;
  const dbMode = await getDashboardModeForAccount(accountId);
  const dashboardMode =
    queryMode === "interactive" ? "interactive" :
    (queryMode === "auto" ? "auto" : dbMode);

  if (String(dashboardMode).toLowerCase() !== "interactive") {
    return res.status(404).send("Not available in auto mode");
  }

  const buildings = Array.from(
    new Set(Object.values(multi_building_groups_by_page || {}).flat().filter(Boolean))
  );

  res.render("buildingControls", {
    user: req.session.user || null,
    dashboardMode,
    buildings
  });
});

/* ==============================
   LOGIN ROUTES
============================== */
app.get("/login", (req, res) => {
  const sql = "SELECT account FROM accounts LIMIT 1";
  connection.query(sql, (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.render("login", {
        adminAccount: null,
        loginError: "Database connection error",
        resetError: null,
        resetSuccess: null
      });
    }

    const adminAccount = results.length > 0 ? results[0].account : null;

    res.render("login", {
      adminAccount: adminAccount,
      loginError: null,
      resetError: null,
      resetSuccess: null
    });
  });
});

app.post("/login", (req, res) => {
  const { password } = req.body;

  const getAccountSql = "SELECT * FROM accounts LIMIT 1";
  connection.query(getAccountSql, async (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Internal Server Error");
    }

    if (results.length === 0) {
      return res.render("login", {
        adminAccount: null,
        loginError: "No admin account found in database",
        resetError: null,
        resetSuccess: null
      });
    }

    const user = results[0];

    try {
      const isHashed = user.password && user.password.startsWith("$2");
      
      let isValidPassword = false;
      
      if (isHashed) {
        isValidPassword = await bcrypt.compare(password, user.password);
      } else {
        isValidPassword = (password === user.password);
        
        if (isValidPassword) {
          const hashedPassword = await bcrypt.hash(password, 10);
          connection.query(
            "UPDATE accounts SET password = ? WHERE id = ?",
            [hashedPassword, user.id],
            (updateErr) => {
              if (updateErr) {
                console.error("Failed to upgrade password hash:", updateErr);
              } else {
                console.log("Password upgraded to bcrypt hash for user:", user.account);
              }
            }
          );
        }
      }

      if (!isValidPassword) {
        return res.render("login", {
          adminAccount: user.account,
          loginError: "Invalid password",
          resetError: null,
          resetSuccess: null
        });
      }

      req.session.user = user;
      res.redirect("/admin");
      
    } catch (compareErr) {
      console.error("Password comparison error:", compareErr);
      return res.status(500).send("Internal Server Error");
    }
  });
});

/* ==============================
   PASSWORD RESET ROUTE
============================== */
app.post("/reset-password", async (req, res) => {
  const { passcode, newPassword, confirmPassword } = req.body;

  const getAccountSql = "SELECT * FROM accounts LIMIT 1";
  connection.query(getAccountSql, async (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.render("login", {
        adminAccount: null,
        loginError: null,
        resetError: "Database error. Please try again.",
        resetSuccess: null
      });
    }

    const adminAccount = results.length > 0 ? results[0].account : null;
    const user = results.length > 0 ? results[0] : null;

    if (!passcode || !newPassword || !confirmPassword) {
      return res.render("login", {
        adminAccount: adminAccount,
        loginError: null,
        resetError: "All fields are required",
        resetSuccess: null
      });
    }

    if (passcode !== RESET_PASSCODE) {
      return res.render("login", {
        adminAccount: adminAccount,
        loginError: null,
        resetError: "Invalid reset passcode",
        resetSuccess: null
      });
    }

    if (newPassword !== confirmPassword) {
      return res.render("login", {
        adminAccount: adminAccount,
        loginError: null,
        resetError: "Passwords do not match",
        resetSuccess: null
      });
    }

    if (newPassword.length < 6) {
      return res.render("login", {
        adminAccount: adminAccount,
        loginError: null,
        resetError: "Password must be at least 6 characters",
        resetSuccess: null
      });
    }

    if (!user) {
      return res.render("login", {
        adminAccount: null,
        loginError: null,
        resetError: "No admin account found",
        resetSuccess: null
      });
    }

    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      const updateSql = "UPDATE accounts SET password = ? WHERE id = ?";
      connection.query(updateSql, [hashedPassword, user.id], (updateErr) => {
        if (updateErr) {
          console.error("Password update error:", updateErr);
          return res.render("login", {
            adminAccount: adminAccount,
            loginError: null,
            resetError: "Failed to update password. Please try again.",
            resetSuccess: null
          });
        }

        console.log("Password reset successful for user:", user.account);
        
        return res.render("login", {
          adminAccount: adminAccount,
          loginError: null,
          resetError: null,
          resetSuccess: "Password reset successful! You can now login with your new password."
        });
      });

    } catch (hashErr) {
      console.error("Reset password error:", hashErr);
      return res.render("login", {
        adminAccount: adminAccount,
        loginError: null,
        resetError: "An error occurred. Please try again.",
        resetSuccess: null
      });
    }
  });
});

/* ==============================
   LOGOUT ROUTE
============================== */
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
    }
    res.redirect("/login");
  });
});

/* ==============================
   ADMIN DASHBOARD ROUTE
============================== */
app.get('/admin', requireAuth, async (req, res) => {
  try {
    const accountId = req.session.user.id; 

    console.log('Admin route - Account ID:', accountId);

    // 1. Fetch buildings metadata
    const [buildingsMeta] = await db.query(
      `SELECT id, account_id as accountId, building_name as name, \`desc\` as description, 
              filename, display_label, card_label,
              elec_startyear, elec_endyear, water_startyear, water_endyear
       FROM building_info 
       WHERE account_id = ?
       ORDER BY building_name`,
      [accountId]
    );

    console.log('Buildings found:', buildingsMeta.length);

    // 2. Fetch years from year_range table
    const [yearRangeRows] = await db.query(
      `SELECT DISTINCT year FROM year_range 
       WHERE account_id = ? 
       ORDER BY year`,
      [accountId]
    );
    const yearRangeYears = (yearRangeRows || []).map(r => Number(r.year));

    console.log('Years from year_range:', yearRangeYears);

    // 3. Fetch years from electricity data
    const [elecYearRows] = await db.query(
      `SELECT DISTINCT YEAR(bill_month) as year 
       FROM building_ebills 
       WHERE account_id = ? AND YEAR(bill_month) IS NOT NULL
       ORDER BY year`,
      [accountId]
    );
    const electricityYears = (elecYearRows || []).map(r => Number(r.year)).filter(y => Number.isFinite(y));

    console.log('Years from electricity:', electricityYears);

    // 4. Fetch years from water data
    const [waterYearRows] = await db.query(
      `SELECT DISTINCT YEAR(bill_month) as year 
       FROM building_waterusage 
       WHERE account_id = ? AND YEAR(bill_month) IS NOT NULL
       ORDER BY year`,
      [accountId]
    );
    const waterYears = (waterYearRows || []).map(r => Number(r.year)).filter(y => Number.isFinite(y));

    console.log('Years from water:', waterYears);

    // 5. Combine all years for general display (allYears)
    const allYearsSet = new Set([
      ...yearRangeYears,
      ...electricityYears,
      ...waterYears
    ]);
    const allYears = Array.from(allYearsSet).sort((a, b) => a - b);

    console.log('Combined years:', allYears);
    console.log('Electricity-only years:', electricityYears);
    console.log('Water-only years:', waterYears);

    // 6. Fetch media
    const [mediaImages] = await db.query(
      `SELECT * FROM dashboard_media 
       WHERE account_id = ? AND media_type = 'image' 
       ORDER BY sort_order`,
      [accountId]
    );

    const [mediaVideos] = await db.query(
      `SELECT * FROM dashboard_media 
       WHERE account_id = ? AND media_type = 'video' 
       ORDER BY sort_order`,
      [accountId]
    );

    // 7. Get dashboard mode
    const [dashModeRows] = await db.query(
      `SELECT dashboard_mode FROM accounts WHERE id = ?`,
      [accountId]
    );
    const dashboardMode = (dashModeRows && dashModeRows[0]) 
      ? (dashModeRows[0].dashboard_mode || 'auto') 
      : 'auto';

    // 8. Fetch timers for page duration settings
    const [timerRows] = await db.query(
      `SELECT timer_id, page_number, page_name, duration_seconds 
       FROM timers 
       WHERE account_id = ? 
       ORDER BY page_number ASC`,
      [accountId]
    );
    const timers = timerRows || [];

    console.log('Dashboard mode:', dashboardMode);
    console.log('Timers found:', timers.length);
    console.log('Rendering admin with:', {
      buildings: buildingsMeta.length,
      allYears: allYears.length,
      electricityYears: electricityYears.length,
      waterYears: waterYears.length,
      images: mediaImages.length,
      videos: mediaVideos.length,
      timers: timers.length
    });

    // 9. Render with ALL data including SEPARATE year arrays and timers
    res.render('admin', {
      buildings: buildingsMeta,
      buildingsMeta: buildingsMeta,
      allYears: allYears,
      electricityYears: electricityYears,  
      waterYears: waterYears,              
      mediaImages: mediaImages || [],
      mediaVideos: mediaVideos || [],
      dashboardMode: dashboardMode,
      timers: timers,
      buildingsLoadError: false
    });

  } catch (error) {
    console.error('Error loading admin page:', error);
    res.render('admin', {
      buildings: [],
      buildingsMeta: [],
      allYears: [],
      electricityYears: [],  
      waterYears: [],        
      mediaImages: [],
      mediaVideos: [],
      dashboardMode: 'auto',
      timers: [],
      buildingsLoadError: true
    });
  }
});


/* ==============================
   ADMIN: SAVE BUILDING YEAR RANGES 
============================== */
app.post("/admin/building-year-ranges", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const accountId = req.session.user.id;
  const { elec_startyears, elec_endyears, water_startyears, water_endyears } = req.body;

  try {
    const [buildings] = await db.query(
      "SELECT id FROM building_info WHERE account_id = ?",
      [accountId]
    );

    for (const building of buildings) {
      const buildingId = building.id;
      
      const elecStart = elec_startyears?.[buildingId] || null;
      const elecEnd = elec_endyears?.[buildingId] || null;
      const waterStart = water_startyears?.[buildingId] || null;
      const waterEnd = water_endyears?.[buildingId] || null;

      await db.query(
        `UPDATE building_info 
         SET elec_startyear = ?, elec_endyear = ?, water_startyear = ?, water_endyear = ? 
         WHERE id = ?`,
        [elecStart, elecEnd, waterStart, waterEnd, buildingId]
      );
    }

    res.redirect("/admin#sec-upload-graph");
  } catch (error) {
    console.error("Error saving building year ranges:", error);
    res.status(500).send("Failed to save year ranges");
  }
});

app.post("/admin/media/:id/update", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized - Please login.");

  const accountId = req.session.user.id;
  const mediaId = Number(req.params.id);
  const sortOrder = Number(req.body.sort_order || 1);
  const isEnabled = String(req.body.is_enabled) === "1" ? 1 : 0;

  try {
    await db.query(
      "UPDATE dashboard_media SET sort_order = ?, is_enabled = ? WHERE id = ? AND account_id = ?",
      [sortOrder, isEnabled, mediaId, accountId]
    );
    return res.redirect("/admin");
  } catch (e) {
    console.error("Failed to update media:", e);
    return res.status(500).send("Failed to update media.");
  }
});

app.post("/admin/media/:id/delete", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized - Please login.");

  const accountId = req.session.user.id;
  const mediaId = Number(req.params.id);

  try {
    const [rows] = await db.query(
      "SELECT id, media_type, filename FROM dashboard_media WHERE id = ? AND account_id = ? LIMIT 1",
      [mediaId, accountId]
    );

    if (!rows || !rows[0]) {
      return res.redirect("/admin");
    }

    const mediaType = String(rows[0].media_type || "").toLowerCase();
    const filenameRaw = String(rows[0].filename || "");
    const filename = path.basename(filenameRaw);

    await db.query("DELETE FROM dashboard_media WHERE id = ? AND account_id = ?", [
      mediaId,
      accountId,
    ]);

    let subFolder = null;
    if (mediaType === "video") subFolder = "videos";
    if (mediaType === "image") subFolder = path.join("images", "carousel");

    if (subFolder && filename) {
      const filePath = path.join(__dirname, "public", "uploads", subFolder, filename);

      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (fileErr) {
        console.warn("Media DB deleted but failed to remove file:", filePath, fileErr);
      }
    }

    return res.redirect("/admin");
  } catch (e) {
    console.error("Failed to delete media:", e);
    return res.status(500).send("Failed to delete media.");
  }
});

app.get("/admin/media/json", requireAuth, async (req, res) => {
  try {
    const accountId = req.session.user.id;
    const type = String(req.query.type || "").toLowerCase();

    if (!["image", "video"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    const [rows] = await db.query(
      `SELECT id, account_id, media_type, filename, sort_order, is_enabled, created_at
       FROM dashboard_media
       WHERE account_id = ? AND media_type = ?
       ORDER BY sort_order ASC, id ASC`,
      [accountId, type]
    );

    res.json({ type, items: rows || [] });
  } catch (e) {
    console.error("media json error:", e);
    res.status(500).json({ error: "Failed to load media" });
  }
});

/* ==============================
   BUILDING PANELS
============================== */

app.get('/building-left/:slug', async (req, res) => {
  const { slug } = req.params;
  const accountId = getAccountId(req); // ✅ Get account ID
  
  try {
    const rawName = buildingRawNameFromSlug(slug);
    const buildingKey = normalizeBuildingKey(rawName);
    
    console.log('Building-left request - Slug:', slug, '→ Building Key:', buildingKey);
    
    const query = `
      SELECT 
        building_name,
        display_label,
        \`desc\`,
        filename,
        card_label,
        elec_startyear,
        elec_endyear,
        water_startyear,
        water_endyear
      FROM building_info 
      WHERE account_id = ? 
        AND (
          UPPER(REPLACE(building_name, ' ', '')) = UPPER(REPLACE(?, ' ', ''))
          OR UPPER(REPLACE(display_label, ' ', '')) = UPPER(REPLACE(?, ' ', ''))
        )
      LIMIT 1
    `;
    
    const [rows] = await db.query(query, [accountId, buildingKey, buildingKey]);
    
    if (!rows || rows.length === 0) {
      console.log('No building info found for building key:', buildingKey);
      return res.render('BuildingDetails', {
        display_label: rawName,
        building_key: buildingKey,
        building_desc: '',
        filename: null,
        elec_start_year: null,
        elec_end_year: null,
        water_start_year: null,
        water_end_year: null,
        error: `No building information found for "${rawName}"`
      });
    }
    
    const building = rows[0];
    console.log('Found building:', building);
    
    res.render('BuildingDetails', {
      display_label: building.display_label || building.building_name || rawName,
      building_key: building.building_name || buildingKey,
      building_desc: building.desc || '',
      filename: building.filename || null,
      elec_start_year: building.elec_startyear || null,
      elec_end_year: building.elec_endyear || null,
      water_start_year: building.water_startyear || null,
      water_end_year: building.water_endyear || null,
      error: null
    });
    
  } catch (error) {
    console.error('Error fetching building info:', error);
    res.render('BuildingDetails', {
      display_label: '',
      building_key: '',
      building_desc: '',
      filename: null,
      elec_start_year: null,
      elec_end_year: null,
      water_start_year: null,
      water_end_year: null,
      error: 'Error loading building information'
    });
  }
});


app.get("/building-right/:code", async (req, res) => {
  const accountId = getAccountId(req);
  const incoming = String(req.params.code || "").trim();

  try {
    const rawName = buildingRawNameFromSlug(incoming);
    const slug = infoSlugFromBuildingRawName(rawName);
    const buildingKey = normalizeBuildingKey(rawName);

    if (!/^[a-z0-9\-]+$/.test(slug)) {
      return res.status(400).send("Invalid building code");
    }

    const viewPath = path.join(__dirname, "views", "infographics", "DynamicInfo.ejs");
    if (!fs.existsSync(viewPath)) {
      return res.status(404).send("<p class='text-muted'>No infographic available.</p>");
    }

    const { allYears, latestYear } = await getYearsForAccount(accountId);

    let buildingMonthlyDetail = null;
    if (latestYear && buildingKey) {
      try {
        buildingMonthlyDetail = await getBuildingMonthlyDetail(accountId, latestYear, rawName);
      } catch (e) {
        console.error("Error fetching building monthly detail:", e);
      }
    }

    const buildingDataByYear = {};
    for (const year of allYears) {
      try {
        const detail = await getBuildingMonthlyDetail(accountId, year, rawName);
        if (detail) {
          buildingDataByYear[year] = detail;
        }
      } catch (e) {
        console.error(`Error fetching building data for year ${year}:`, e);
      }
    }

    let solarData = [];
    if (latestYear) {
      try {
        solarData = await getSolarForYear(accountId, latestYear);
      } catch (e) {
        console.error("Error fetching solar data:", e);
      }
    }

    const solarDataByYear = {};
    for (const year of allYears) {
      try {
        const data = await getSolarForYear(accountId, year);
        solarDataByYear[year] = data || [];
      } catch (e) {
        console.error(`Error fetching solar data for year ${year}:`, e);
      }
    }

    let wasteData = [];
    if (latestYear) {
      try {
        wasteData = await getWasteForFiscalYear(accountId, latestYear);
      } catch (e) {
        console.error("Error fetching waste data:", e);
      }
    }

    const wasteDataByYear = {};
    for (const year of allYears) {
      try {
        const data = await getWasteForFiscalYear(accountId, year);
        wasteDataByYear[year] = data || [];
      } catch (e) {
        console.error(`Error fetching waste data for year ${year}:`, e);
      }
    }

    const buildingYearlyTotals = [];
    for (const year of allYears) {
      const detail = buildingDataByYear[year];
      if (detail) {
        const elecTotal = (detail.elec || []).reduce((sum, v) => sum + Number(v || 0), 0);
        const waterTotal = (detail.water || []).reduce((sum, v) => sum + Number(v || 0), 0);
        buildingYearlyTotals.push({
          year: year,
          electricity: elecTotal,
          water: waterTotal
        });
      }
    }

    const solarYearlyTotals = [];
    for (const year of allYears) {
      const months = solarDataByYear[year] || [];
      const urbanTotal = months.reduce((sum, m) => sum + Number(m.urban || 0), 0);
      const greenhouseTotal = months.reduce((sum, m) => sum + Number(m.greenhouse || 0), 0);
      solarYearlyTotals.push({
        year: year,
        urbanRenewables: urbanTotal,
        greenHouse: greenhouseTotal
      });
    }

    const wasteYearlyTotals = [];
    for (const year of allYears) {
      const months = wasteDataByYear[year] || [];
      const generalTotal = months.reduce((sum, m) => sum + Number(m.generalKg || 0), 0);
      const recyclableTotal = months.reduce((sum, m) => sum + Number(m.recyclableKg || 0), 0);
      wasteYearlyTotals.push({
        fiscalYear: "FY " + year,
        year: year,
        generalWaste: generalTotal,
        recyclableWaste: recyclableTotal
      });
    }

    return res.render("infographics/DynamicInfo", {
      allYears: allYears || [],
      latestYear: latestYear || null,
      buildingRaw: rawName || "",
      buildingKey: buildingKey || rawName || "",
      infoSlug: slug || "",
      
      buildingMonthlyDetail: buildingMonthlyDetail || null,
      buildingDataByYear: buildingDataByYear || {},
      buildingYearlyTotals: buildingYearlyTotals || [],
      
      solarData: solarData || [],
      solarDataByYear: solarDataByYear || {},
      solarYearlyTotals: solarYearlyTotals || [],
      
      wasteData: wasteData || [],
      wasteDataByYear: wasteDataByYear || {},
      wasteYearlyTotals: wasteYearlyTotals || []
    });
  } catch (err) {
    console.error("Right panel render error:", err);
    return res.status(500).send("<p class='text-muted'>Failed to load infographic.</p>");
  }
});

/* ==============================
   SOLAR + WASTE DATA PAGES (JSON APIs)
============================== */

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

app.get('/info/solar', async (req, res) => {
  const accountId = getAccountId(req); 
  const year = req.query.year;

  try {
    const [results] = await db.query(
      `SELECT bill_month, urban_renewables, green_house 
       FROM total_solardata 
       WHERE account_id = ? AND YEAR(bill_month) = ?`,
      [accountId, year]
    );

    if (results.length > 0) {
      res.json(results);
    } else {
      res.json({ message: "No solar data available for the selected year." });
    }
  } catch (error) {
    console.error('Error fetching solar data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/info/waste', async (req, res) => {
  const accountId = getAccountId(req);
  const fiscalYear = req.query.fy;

  try {
    const [results] = await db.query(
      `SELECT bill_month, general_kg, recyclable_kg, general_percent, recyclable_percent 
       FROM total_wastedata 
       WHERE account_id = ? AND YEAR(bill_month) = ?`,
      [accountId, fiscalYear]
    );

    if (results.length > 0) {
      res.json(results);
    } else {
      res.json({ message: "No waste data available for the selected fiscal year." });
    }
  } catch (error) {
    console.error('Error fetching waste data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==============================
   INFOGRAPHICS ROUTES
   These routes render EJS templates for Solar and Waste info panels
============================== */

/**
 * GET /infographics/SolarInfo
 * Renders the Solar info panel for the left side of Page 6
 */
app.get('/infographics/SolarInfo', async (req, res) => {
  const accountId = getAccountId(req);
  const requestedYear = req.query.year ? Number(req.query.year) : null;

  try {
    // Get all years and latest year
    const { allYears, latestYear } = await getYearsForAccount(accountId);
    
    // Use requested year or fall back to latest
    const year = requestedYear || latestYear;
    
    // Fetch solar data for the specified year
    let solarMonths = [];
    if (year) {
      solarMonths = await getSolarForYear(accountId, year);
    }

    // Calculate totals
    const urbanTotal = solarMonths.reduce((sum, m) => sum + safeNumber(m.urban), 0);
    const greenhouseTotal = solarMonths.reduce((sum, m) => sum + safeNumber(m.greenhouse), 0);
    const totalSolar = urbanTotal + greenhouseTotal;

    // Fetch yearly totals for all years (for comparison/trend display)
    const solarYearlyTotals = [];
    for (const y of allYears) {
      const months = await getSolarForYear(accountId, y);
      const urbanYearTotal = months.reduce((sum, m) => sum + safeNumber(m.urban), 0);
      const ghYearTotal = months.reduce((sum, m) => sum + safeNumber(m.greenhouse), 0);
      solarYearlyTotals.push({
        year: y,
        urbanRenewables: urbanYearTotal,
        greenHouse: ghYearTotal,
        total: urbanYearTotal + ghYearTotal
      });
    }

    // Check if template exists
    const viewPath = path.join(__dirname, "views", "infographics", "SolarInfo.ejs");
    if (!fs.existsSync(viewPath)) {
      // Return a default HTML if template doesn't exist
      return res.send(`
        <div class="slug-sandbox">
          <div class="info-head">
            <div class="info-title">☀️ Solar Energy</div>
            <div class="info-subtitle">Year ${year || 'N/A'}</div>
          </div>
          <div class="info-section" style="margin-top: 10px;">
            <div class="info-section-h">Generation Summary</div>
            <ul class="info-bullets">
              <li>Urban Renewables: ${urbanTotal.toLocaleString()} kWh</li>
              <li>Green House: ${greenhouseTotal.toLocaleString()} kWh</li>
              <li><strong>Total: ${totalSolar.toLocaleString()} kWh</strong></li>
            </ul>
          </div>
        </div>
      `);
    }

    return res.render("infographics/SolarInfo", {
      year: year,
      allYears: allYears || [],
      latestYear: latestYear,
      solarMonths: solarMonths || [],
      urbanTotal: urbanTotal,
      greenhouseTotal: greenhouseTotal,
      totalSolar: totalSolar,
      solarYearlyTotals: solarYearlyTotals || []
    });

  } catch (err) {
    console.error("Error rendering SolarInfo:", err);
    return res.status(500).send("<p class='text-muted'>Failed to load solar information.</p>");
  }
});

/**
 * GET /infographics/WasteInfo
 * Renders the Waste info panel for the left side of Page 7
 */
app.get('/infographics/WasteInfo', async (req, res) => {
  const accountId = getAccountId(req);
  const requestedFY = req.query.fy ? Number(req.query.fy) : null;

  try {
    // Get all years and latest year
    const { allYears, latestYear } = await getYearsForAccount(accountId);
    
    // Use requested fiscal year or fall back to latest
    const fiscalYear = requestedFY || latestYear;
    
    // Fetch waste data for the specified fiscal year
    let wasteMonths = [];
    if (fiscalYear) {
      wasteMonths = await getWasteForFiscalYear(accountId, fiscalYear);
    }

    // Calculate totals
    const generalTotal = wasteMonths.reduce((sum, m) => sum + safeNumber(m.generalKg), 0);
    const recyclableTotal = wasteMonths.reduce((sum, m) => sum + safeNumber(m.recyclableKg), 0);
    const totalWaste = generalTotal + recyclableTotal;
    
    // Calculate recycling rate
    const recyclingRate = totalWaste > 0 ? ((recyclableTotal / totalWaste) * 100).toFixed(1) : 0;

    // Fetch yearly totals for all years (for comparison/trend display)
    const wasteYearlyTotals = [];
    for (const y of allYears) {
      const months = await getWasteForFiscalYear(accountId, y);
      const genYearTotal = months.reduce((sum, m) => sum + safeNumber(m.generalKg), 0);
      const recYearTotal = months.reduce((sum, m) => sum + safeNumber(m.recyclableKg), 0);
      const yearTotal = genYearTotal + recYearTotal;
      const yearRecyclingRate = yearTotal > 0 ? ((recYearTotal / yearTotal) * 100).toFixed(1) : 0;
      
      wasteYearlyTotals.push({
        fiscalYear: "FY " + y,
        year: y,
        generalWaste: genYearTotal,
        recyclableWaste: recYearTotal,
        total: yearTotal,
        recyclingRate: yearRecyclingRate
      });
    }

    // Check if template exists
    const viewPath = path.join(__dirname, "views", "infographics", "WasteInfo.ejs");
    if (!fs.existsSync(viewPath)) {
      // Return a default HTML if template doesn't exist
      return res.send(`
        <div class="slug-sandbox">
          <div class="info-head">
            <div class="info-title">🗑️ Waste Management</div>
            <div class="info-subtitle">FY ${fiscalYear || 'N/A'}</div>
          </div>
          <div class="info-section" style="margin-top: 10px;">
            <div class="info-section-h">Waste Summary</div>
            <ul class="info-bullets">
              <li>General Waste: ${generalTotal.toLocaleString()} kg</li>
              <li>Recyclable Waste: ${recyclableTotal.toLocaleString()} kg</li>
              <li><strong>Total: ${totalWaste.toLocaleString()} kg</strong></li>
              <li>Recycling Rate: ${recyclingRate}%</li>
            </ul>
          </div>
        </div>
      `);
    }

    // Render the EJS template
    return res.render("infographics/WasteInfo", {
      fiscalYear: fiscalYear,
      allYears: allYears || [],
      latestYear: latestYear,
      wasteMonths: wasteMonths || [],
      generalTotal: generalTotal,
      recyclableTotal: recyclableTotal,
      totalWaste: totalWaste,
      recyclingRate: recyclingRate,
      wasteYearlyTotals: wasteYearlyTotals || []
    });

  } catch (err) {
    console.error("Error rendering WasteInfo:", err);
    return res.status(500).send("<p class='text-muted'>Failed to load waste information.</p>");
  }
});

/* ==============================
   BUILDING INFO PAGE
============================== */

app.get("/building/:code/info", async (req, res) => {
  const accountId = getAccountId(req);

  let code = String(req.params.code || "").trim().toLowerCase();
  if (code === "sit") code = "blk-43";

  if (!/^[a-z0-9\-]+$/.test(code)) {
    return res.status(400).send("Invalid building code");
  }

  const includeView = `info/${code}`;
  const includePath = path.join(__dirname, "views", "info", `${code}.ejs`);
  if (!fs.existsSync(includePath)) {
    return res.status(404).send(`Info page not found for: ${code}`);
  }

  try {
    const { allYears, latestYear } = await getYearsForAccount(accountId);

    const buildingRaw = buildingRawNameFromSlug(code);
    const displayLabel = buildingDisplayLabelFromKey(normalizeBuildingKey(buildingRaw));

    return res.render(includeView, {
      user: req.session.user || null,
      code,
      buildingCode: code,
      buildingRaw,
      displayLabel,
      allYears: allYears || [],
      latestYear: latestYear || null,
    });
  } catch (err) {
    console.error("Error rendering info page:", err);
    return res.status(500).send("Internal Server Error");
  }
});

/* ==============================
   FILE UPLOAD ROUTES
============================== */
app.post("/uploads/videos", uploadVideo.single("videoFile"), async (req, res) => {
  if (!req.file) return res.status(400).send("No video file uploaded.");
  if (!req.session.user) return res.status(401).send("Unauthorized - Please login.");

  const accountId = req.session.user.id;

  try {
    const nextOrder = await getNextMediaSortOrder(accountId, "video");
    await db.query(
      "INSERT INTO dashboard_media (account_id, media_type, filename, sort_order, is_enabled) VALUES (?, 'video', ?, ?, 1)",
      [accountId, req.file.filename, nextOrder]
    );
  } catch (e) {
    console.error("Failed to insert video into dashboard_media:", e);
  }

  res.send(`Video file uploaded: ${req.file.filename}`);
});

app.post("/uploads/image/carousel", uploadCarouselImages.single("imageFile"), async (req, res) => {
  if (!req.file) return res.status(400).send("No image file uploaded.");
  if (!req.session.user) return res.status(401).send("Unauthorized - Please login.");

  const accountId = req.session.user.id;

  try {
    const nextOrder = await getNextMediaSortOrder(accountId, "image");
    await db.query(
      "INSERT INTO dashboard_media (account_id, media_type, filename, sort_order, is_enabled) VALUES (?, 'image', ?, ?, 1)",
      [accountId, req.file.filename, nextOrder]
    );
  } catch (e) {
    console.error("Failed to insert image into dashboard_media:", e);
  }

  res.send(`Image file uploaded: ${req.file.filename}`);
});

/* ==============================
   XLSX UPLOAD HANDLER
============================== */
app.post("/upload/xlsx", uploadExcel.single("xlsxFile"), async (req, res) => {
  if (!req.file) return res.status(400).send("Failed to upload, No file provided");
  if (!req.session.user) return res.status(401).send("Failed to upload, Unauthorized");

  const accountId = req.session.user.id;
  const buildingNameSet = new Set();
  const detectedYears = new Set();

  // Track year ranges per building
  const buildingElecYears = new Map();
  const buildingWaterYears = new Map();

  // Track incomplete data warnings
  const incompleteDataWarnings = [];

  try {
    const workbook = XLSX.readFile(req.file.path);

    if (workbook.SheetNames.length < 6) {
      return res.status(400).send("Failed to upload, Excel format not supported (needs 6 sheets)");
    }

    const sheet1 = workbook.Sheets[workbook.SheetNames[0]];
    const sheet2 = workbook.Sheets[workbook.SheetNames[1]];
    const sheet3 = workbook.Sheets[workbook.SheetNames[2]];
    const sheet4 = workbook.Sheets[workbook.SheetNames[3]];
    const sheet5 = workbook.Sheets[workbook.SheetNames[4]];
    const sheet6 = workbook.Sheets[workbook.SheetNames[5]];

    if (!sheet1["B3"] || !sheet1["D3"]) {
      return res.status(400).send("Failed to upload, Excel format not supported (missing B3 or D3)");
    }

    // ===================== DETECT YEARS FROM TAB 1 =====================
    console.log("Detecting years from Tab 1...");

    let yearRowIndex = 3;
    const maxYearsToDetect = 20;
    let yearsFound = 0;

    while (yearsFound < maxYearsToDetect) {
      const cellRef = `B${yearRowIndex}`;
      const cell = sheet1[cellRef];

      if (!cell || cell.v === undefined || cell.v === null || String(cell.v).trim() === "") {
        break;
      }

      const yearValue = Number(cell.v);

      if (Number.isFinite(yearValue) && yearValue >= 2000 && yearValue <= 2100) {
        detectedYears.add(yearValue);
        console.log(`Found year ${yearValue} at ${cellRef}`);
        yearsFound++;
        yearRowIndex += 12;
      } else {
        console.warn(`Cell ${cellRef} contains "${cell.v}" - not a valid year`);
        break;
      }
    }

    const yearsArray = Array.from(detectedYears).sort((a, b) => a - b);
    console.log(`Detected ${yearsArray.length} years:`, yearsArray);

    if (yearsArray.length === 0) {
      return res.status(400).send("Failed to upload, No valid years found in Excel");
    }

    // ===================== CLEAR OLD DATA =====================
    console.log("Clearing existing data...");

    await db.query("START TRANSACTION");

    const tables = [
      "total_ebills",
      "building_ebills",
      "total_waterusage",
      "building_waterusage",
      "total_solardata",
      "total_wastedata",
    ];

    for (const table of tables) {
      try {
        await db.query(`DELETE FROM ${table} WHERE account_id = ?`, [accountId]);
      } catch (err) {
        console.warn(`Could not clear ${table}:`, err.message);
      }
    }

    const yearsSaved = await saveYearsForAccount(accountId, yearsArray);
    if (!yearsSaved) {
      await db.query("ROLLBACK");
      return res.status(500).send("Failed to upload, Could not save year range");
    }

    await db.query("COMMIT");

    // ===================== TAB 1: TOTAL ELECTRIC BILLS =====================
    console.log("Processing Tab 1: Total Electric Bills...");

    const insertTotalElectricSQL =
      "INSERT INTO total_ebills (account_id, bill_month, total_bill) VALUES (?, ?, ?)";

    for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
      const year = yearsArray[yearIndex];
      const startRow = 3 + yearIndex * 12;
      let monthsWithData = 0;

      for (let month = 1; month <= 12; month++) {
        const dataRow = startRow + (month - 1);
        const billValue = sheet1[`D${dataRow}`] ? Number(sheet1[`D${dataRow}`].v) || 0 : 0;
        const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;

        if (billValue > 0) {
          monthsWithData++;
        }

        await db.query(insertTotalElectricSQL, [accountId, billMonth, billValue]);
      }

      if (monthsWithData < 12) {
        console.warn(`WARNING: Year ${year} - Total Electric has incomplete data (${monthsWithData}/12 months)`);
        incompleteDataWarnings.push(`Tab 1 Total Electric ${year}: ${monthsWithData}/12 months`);
      } else {
        console.log(`Year ${year} - Total Electric complete (12/12 months)`);
      }
    }

    console.log(`Tab 1: Inserted ${yearsArray.length * 12} total electric records`);

    // ===================== TAB 2: BUILDING ELECTRIC BILLS =====================
    console.log("Processing Tab 2: Building Electric Bills...");

    const insertBuildingElectricSQL =
      "INSERT INTO building_ebills (account_id, building_name, bill_month, bill_amount) VALUES (?, ?, ?, ?)";

    for (let colIndex = 2; colIndex <= 23; colIndex++) {
      const col = XLSX.utils.encode_col(colIndex);
      const buildingNameRaw = sheet2[`${col}4`]?.v;
      const buildingName = BuildingNameStandardized(buildingNameRaw);

      if (!buildingName) continue;
      buildingNameSet.add(buildingName);

      if (!buildingElecYears.has(buildingName)) {
        buildingElecYears.set(buildingName, new Set());
      }

      for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
        const year = yearsArray[yearIndex];
        const startRow = 5 + yearIndex * 15;
        let monthsWithData = 0;
        let hasAnyData = false;

        for (let month = 1; month <= 12; month++) {
          const dataRow = startRow + (month - 1);
          const billValue = sheet2[`${col}${dataRow}`] ? Number(sheet2[`${col}${dataRow}`].v) || 0 : 0;
          const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;

          if (billValue > 0) {
            monthsWithData++;
            hasAnyData = true;
          }

          await db.query(insertBuildingElectricSQL, [accountId, buildingName, billMonth, billValue]);
        }

        if (hasAnyData) {
          buildingElecYears.get(buildingName).add(year);
        }

        if (monthsWithData < 12 && monthsWithData > 0) {
          console.warn(`WARNING: Year ${year} - Building "${buildingName}" Electric has incomplete data (${monthsWithData}/12 months)`);
          incompleteDataWarnings.push(`Tab 2 Building Electric "${buildingName}" ${year}: ${monthsWithData}/12 months`);
        }
      }
    }

    console.log(`Tab 2: Inserted building electric records for ${buildingNameSet.size} buildings`);

    // ===================== TAB 3: TOTAL WATER USAGE =====================
    console.log("Processing Tab 3: Total Water Usage...");

    const insertTotalWaterSQL =
      "INSERT INTO total_waterusage (account_id, bill_month, portable_water, recycled_water) VALUES (?, ?, ?, ?)";

    for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
      const year = yearsArray[yearIndex];
      const startRow = 3 + yearIndex * 12;
      let monthsWithData = 0;

      for (let month = 1; month <= 12; month++) {
        const dataRow = startRow + (month - 1);
        const potable = sheet3[`D${dataRow}`] ? Number(sheet3[`D${dataRow}`].v) || 0 : 0;
        const recycled = sheet3[`E${dataRow}`] ? Number(sheet3[`E${dataRow}`].v) || 0 : 0;
        const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;

        if (potable > 0 || recycled > 0) {
          monthsWithData++;
        }

        await db.query(insertTotalWaterSQL, [accountId, billMonth, potable, recycled]);
      }

      if (monthsWithData < 12) {
        console.warn(`WARNING: Year ${year} - Total Water has incomplete data (${monthsWithData}/12 months)`);
        incompleteDataWarnings.push(`Tab 3 Total Water ${year}: ${monthsWithData}/12 months`);
      } else {
        console.log(`Year ${year} - Total Water complete (12/12 months)`);
      }
    }

    console.log(`Tab 3: Inserted ${yearsArray.length * 12} total water records`);

    // ===================== TAB 4: BUILDING WATER USAGE =====================
    console.log("Processing Tab 4: Building Water Usage...");
    const insertBuildingWaterSQL = "INSERT INTO building_waterusage (account_id, building_name, bill_month, water_used) VALUES (?, ?, ?, ?)";

    function extractYearFromCY(cellValue) {
      if (!cellValue) return null;
      const str = String(cellValue).trim().toUpperCase();
      const match = str.match(/CY(\d{4})/i);
      if (match) {
        const year = parseInt(match[1], 10);
        if (year >= 2000 && year <= 2100) {
          return year;
        }
      }
      return null;
    }

    const startingYearCell = sheet4['B2'];
    if (!startingYearCell || !startingYearCell.v) {
      console.error("Tab 4: No year found in cell B2");
      return res.status(400).send("Failed to upload, Tab 4 missing year in B2");
    }

    const startingYear = extractYearFromCY(startingYearCell.v);
    if (!startingYear) {
      console.error(`Tab 4: Invalid year format in B2: "${startingYearCell.v}". Expected CYXXXX format.`);
      return res.status(400).send("Failed to upload, Tab 4 invalid year format in B2");
    }

    console.log(`Tab 4: Starting year from B2: ${startingYear}`);

    const tab4Buildings = [];
    for (let colIndex = 2; colIndex <= 21; colIndex++) {
      const col = XLSX.utils.encode_col(colIndex);
      const buildingNameRaw = sheet4[`${col}3`]?.v;
      const buildingName = BuildingNameStandardized(buildingNameRaw);
      
      if (buildingName) {
        tab4Buildings.push({ col, name: buildingName });
        buildingNameSet.add(buildingName);
        
        if (!buildingWaterYears.has(buildingName)) {
          buildingWaterYears.set(buildingName, new Set());
        }
      }
    }

    console.log(`Tab 4: Found ${tab4Buildings.length} buildings`);

    let yearBlocks = [];
    let currentYear = startingYear;
    let blockIndex = 0;
    const maxBlocks = 10;

    while (blockIndex < maxBlocks) {
      const startRow = 4 + (blockIndex * 15);
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
      
      yearBlocks.push({ year: currentYear, startRow: startRow });
      console.log(`Tab 4: Found data block for year ${currentYear} starting at row ${startRow}`);
      currentYear++;
      blockIndex++;
    }

    console.log(`Tab 4: Processing ${yearBlocks.length} year blocks`);

    for (const building of tab4Buildings) {
      console.log(`Tab 4: Processing building "${building.name}" in column ${building.col}`);
      
      for (const yearBlock of yearBlocks) {
        const year = yearBlock.year;
        const startRow = yearBlock.startRow;
        let monthsWithData = 0;
        let hasAnyData = false;

        for (let month = 1; month <= 12; month++) {
          const dataRow = startRow + (month - 1);
          const waterUsed = sheet4[`${building.col}${dataRow}`] ? Number(sheet4[`${building.col}${dataRow}`].v) || 0 : 0;
          const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;

          if (waterUsed > 0) {
            monthsWithData++;
            hasAnyData = true;
          }

          await db.query(insertBuildingWaterSQL, [accountId, building.name, billMonth, waterUsed]);
        }

        if (hasAnyData) {
          buildingWaterYears.get(building.name).add(year);
        }

        if (monthsWithData < 12 && monthsWithData > 0) {
          console.warn(`WARNING: Year ${year} - Building "${building.name}" Water has incomplete data (${monthsWithData}/12 months)`);
          incompleteDataWarnings.push(`Tab 4 Building Water "${building.name}" ${year}: ${monthsWithData}/12 months`);
        } else if (monthsWithData === 12) {
          console.log(`Tab 4: Year ${year} - Building "${building.name}" complete (12/12 months)`);
        }
      }
    }

    console.log(`Tab 4: Inserted building water records for ${tab4Buildings.length} buildings across ${yearBlocks.length} years`);

    // ===================== TAB 5: SOLAR DATA =====================
    console.log("Processing Tab 5: Solar Data...");

    const insertSolarSQL = "INSERT INTO total_solardata (account_id, bill_month, urban_renewables, green_house) VALUES (?, ?, ?, ?)";
    for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
      const year = yearsArray[yearIndex];
      const startRow = 3 + yearIndex * 12;
      let monthsWithData = 0;

      for (let month = 1; month <= 12; month++) {
        const dataRow = startRow + (month - 1);
        const urbanRenewables = sheet5[`D${dataRow}`] ? Number(sheet5[`D${dataRow}`].v) || 0 : 0;
        const greenHouse = sheet5[`E${dataRow}`] ? Number(sheet5[`E${dataRow}`].v) || 0 : 0;
        const billMonth = `${year}-${String(month).padStart(2, "0")}-01`;

        if (urbanRenewables > 0 || greenHouse > 0) {
          monthsWithData++;
        }

        await db.query(insertSolarSQL, [accountId, billMonth, urbanRenewables, greenHouse]);
      }

      if (monthsWithData < 12) {
        console.warn(`WARNING: Year ${year} - Solar Data has incomplete data (${monthsWithData}/12 months)`);
        incompleteDataWarnings.push(`Tab 5 Solar ${year}: ${monthsWithData}/12 months`);
      } else {
        console.log(`Year ${year} - Solar Data complete (12/12 months)`);
      }
    }

    console.log(`Tab 5: Inserted ${yearsArray.length * 12} solar records`);

    // ===================== TAB 6: WASTE DATA (FISCAL YEAR) =====================
    console.log("Processing Tab 6: Waste Data (Fiscal Year)...");

    const insertWasteSQL = `
      INSERT INTO total_wastedata 
      (account_id, bill_month, general_kg, recyclable_kg, general_percent, recyclable_percent)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const fiscalMonthOrder = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
    const FY_LABEL_START_ROW = 7;
    const ROWS_PER_FY_BLOCK = 13;

    function parseFiscalYearLabel(cellValue) {
      if (!cellValue) return null;
      const str = String(cellValue).trim().toUpperCase();
      const match = str.match(/FY\s*(\d{2,4})/i);
      if (!match) return null;
      
      let year = parseInt(match[1], 10);
      if (year < 100) {
        year = year + 2000;
      }
      
      if (year >= 2000 && year <= 2100) {
        return year;
      }
      return null;
    }

    function countMonthsWithData(sheet, dataStartRow) {
      let monthsWithData = 0;
      
      for (let i = 0; i < 12; i++) {
        const dataRow = dataStartRow + i;
        const generalKg = sheet[`B${dataRow}`] ? Number(sheet[`B${dataRow}`].v) || 0 : 0;
        const recycleKg = sheet[`C${dataRow}`] ? Number(sheet[`C${dataRow}`].v) || 0 : 0;
        
        if (generalKg > 0 || recycleKg > 0) {
          monthsWithData++;
        }
      }
      
      return monthsWithData;
    }

    const detectedFiscalYears = [];
    let fyIndex = 0;
    const maxFYsToDetect = 20;

    while (fyIndex < maxFYsToDetect) {
      const labelRow = FY_LABEL_START_ROW + (fyIndex * ROWS_PER_FY_BLOCK);
      const labelCell = sheet6[`A${labelRow}`];
      
      if (!labelCell || labelCell.v === undefined || labelCell.v === null) {
        break;
      }
      
      const fyStartYear = parseFiscalYearLabel(labelCell.v);
      
      if (fyStartYear) {
        const dataStartRow = labelRow + 1;
        const monthsWithData = countMonthsWithData(sheet6, dataStartRow);
        
        detectedFiscalYears.push({
          fyStartYear: fyStartYear,
          labelRow: labelRow,
          dataStartRow: dataStartRow,
          monthsWithData: monthsWithData
        });
        
        if (monthsWithData === 12) {
          console.log(`Found FY${fyStartYear} at row A${labelRow} (Complete: 12/12 months)`);
        } else {
          console.warn(`WARNING: Found FY${fyStartYear} at row A${labelRow} (Incomplete: ${monthsWithData}/12 months)`);
          incompleteDataWarnings.push(`Tab 6 Waste FY${fyStartYear}: ${monthsWithData}/12 months`);
        }
        
        fyIndex++;
      } else {
        console.warn(`Cell A${labelRow} contains "${labelCell.v}" - not a valid FY label`);
        break;
      }
    }

    console.log(`Detected ${detectedFiscalYears.length} fiscal years in Sheet 6`);

    let insertedFYCount = 0;

    for (const fy of detectedFiscalYears) {
      const fyStartYear = fy.fyStartYear;
      const dataStartRow = fy.dataStartRow;
      
      if (fy.monthsWithData < 12) {
        console.log(`Inserting FY${fyStartYear} (Apr ${fyStartYear} - Mar ${fyStartYear + 1}), rows ${dataStartRow}-${dataStartRow + 11} [INCOMPLETE]`);
      } else {
        console.log(`Inserting FY${fyStartYear} (Apr ${fyStartYear} - Mar ${fyStartYear + 1}), rows ${dataStartRow}-${dataStartRow + 11}`);
      }
      
      for (let i = 0; i < 12; i++) {
        const dataRow = dataStartRow + i;
        const calendarMonth = fiscalMonthOrder[i];
        const calendarYear = calendarMonth >= 4 ? fyStartYear : fyStartYear + 1;
        
        const generalKg = sheet6[`B${dataRow}`] ? Number(sheet6[`B${dataRow}`].v) || 0 : 0;
        const recycleKg = sheet6[`C${dataRow}`] ? Number(sheet6[`C${dataRow}`].v) || 0 : 0;
        const generalPct = sheet6[`D${dataRow}`] ? Number(sheet6[`D${dataRow}`].v) || 0 : 0;
        const recyclePct = sheet6[`E${dataRow}`] ? Number(sheet6[`E${dataRow}`].v) || 0 : 0;
        
        const billMonth = `${calendarYear}-${String(calendarMonth).padStart(2, "0")}-01`;
        
        await db.query(insertWasteSQL, [
          accountId,
          billMonth,
          generalKg,
          recycleKg,
          generalPct,
          recyclePct,
        ]);
      }
      
      insertedFYCount++;
    }

    console.log(`Tab 6: Inserted waste data for ${insertedFYCount} fiscal years`);

    // ===================== BUILDING INFO WITH YEAR RANGES =====================
    if (buildingNameSet.size > 0) {
      console.log("\nUpdating building info with electricity and water year ranges...");
      
      const [existingRows] = await db.query(
        "SELECT id, building_name FROM building_info WHERE account_id = ?",
        [accountId]
      );

      const existingMap = new Map();
      (existingRows || []).forEach((r) => {
        const standardized = BuildingNameStandardized(r.building_name);
        existingMap.set(standardized, r.id);
      });

      const insertBuildingInfoSQL = `
        INSERT INTO building_info 
        (account_id, building_name, \`desc\`, filename, elec_startyear, elec_endyear, water_startyear, water_endyear) 
        VALUES (?, ?, '', NULL, ?, ?, ?, ?)
      `;

      const updateYearRangeSQL = `
        UPDATE building_info 
        SET elec_startyear = ?, elec_endyear = ?, water_startyear = ?, water_endyear = ? 
        WHERE id = ?
      `;

      let newBuildingsAdded = 0;
      let buildingsUpdated = 0;

      for (const name of buildingNameSet) {
        // Get electricity year range
        const elecYearsSet = buildingElecYears.get(name);
        let elecStart = null;
        let elecEnd = null;
        
        if (elecYearsSet && elecYearsSet.size > 0) {
          const elecYearsArr = Array.from(elecYearsSet).sort((a, b) => a - b);
          elecStart = elecYearsArr[0];
          elecEnd = elecYearsArr[elecYearsArr.length - 1];
        }

        // Get water year range
        const waterYearsSet = buildingWaterYears.get(name);
        let waterStart = null;
        let waterEnd = null;
        
        if (waterYearsSet && waterYearsSet.size > 0) {
          const waterYearsArr = Array.from(waterYearsSet).sort((a, b) => a - b);
          waterStart = waterYearsArr[0];
          waterEnd = waterYearsArr[waterYearsArr.length - 1];
        }
        
        const existingId = existingMap.get(name);
        
        if (existingId) {
          await db.query(updateYearRangeSQL, [elecStart, elecEnd, waterStart, waterEnd, existingId]);
          buildingsUpdated++;
          console.log(`  ✓ Updated "${name}": Elec(${elecStart || 'NULL'}-${elecEnd || 'NULL'}) Water(${waterStart || 'NULL'}-${waterEnd || 'NULL'})`);
        } else {
          await db.query(insertBuildingInfoSQL, [accountId, name, elecStart, elecEnd, waterStart, waterEnd]);
          newBuildingsAdded++;
          console.log(`  ✓ Inserted "${name}": Elec(${elecStart || 'NULL'}-${elecEnd || 'NULL'}) Water(${waterStart || 'NULL'}-${waterEnd || 'NULL'})`);
        }
      }

      console.log(`\nBuilding info summary:`);
      console.log(`  - Total buildings: ${buildingNameSet.size}`);
      console.log(`  - New buildings added: ${newBuildingsAdded}`);
      console.log(`  - Existing buildings updated: ${buildingsUpdated}`);
    }

    // ===================== SUMMARY OF WARNINGS =====================
    if (incompleteDataWarnings.length > 0) {
      console.warn("\n==================== INCOMPLETE DATA SUMMARY ====================");
      console.warn(`Total incomplete data entries: ${incompleteDataWarnings.length}`);
      incompleteDataWarnings.forEach((warning, index) => {
        console.warn(`${index + 1}. ${warning}`);
      });
      console.warn("====================================================================\n");
    }

    // ===================== CLEANUP =====================
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (cleanupErr) {
      console.warn("Could not delete uploaded file:", cleanupErr.message);
    }

    // ===================== SUCCESS =====================
    const buildingsList = Array.from(buildingNameSet).sort().join(", ");

    console.log("Upload complete!");
    console.log(`Years: ${yearsArray.join(", ")}`);
    console.log(`Buildings: ${buildingNameSet.size}`);

    res.send(
      `Data successfully uploaded! Years: ${yearsArray.join(", ")} | Buildings: ${buildingsList}`
    );

  } catch (error) {
    console.error("XLSX Processing Error:", error);

    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Rollback error:", rollbackErr);
    }

    try {
      if (req.file && req.file.path && fs.existsSync(req.file.path))
        fs.unlinkSync(req.file.path);
    } catch (cleanupErr) {}

    if (
      error.message &&
      (error.message.includes("Unsupported file") ||
        error.message.includes("Invalid") ||
        error.message.includes("XLSX"))
    ) {
      return res.status(400).send("Failed to upload, Excel format not supported");
    }

    res.status(500).send(`Failed to upload: ${error.message}`);
  }
});

/* ==============================
   CLEAR DATA ROUTE 
============================== */
app.post("/clear/all", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Failed to clear, Unauthorized");

  const accountId = req.session.user.id;

  try {
    await db.query("START TRANSACTION");

    // Tables to completely clear
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
      try {
        await db.query(`DELETE FROM ${table} WHERE account_id = ?`, [accountId]);
      } catch (err) {
        console.warn(`Could not clear ${table}:`, err.message);
      }
    }

    // Reset year range columns in building_info (set to NULL)
    try {
      await db.query(
        `UPDATE building_info 
         SET elec_startyear = NULL, 
             elec_endyear = NULL, 
             water_startyear = NULL, 
             water_endyear = NULL 
         WHERE account_id = ?`,
        [accountId]
      );
    } catch (err) {
      console.warn("Could not reset building_info year ranges:", err.message);
    }

    await db.query("COMMIT");
    res.send("All data cleared successfully");

  } catch (err) {
    await db.query("ROLLBACK");
    console.error("Clear error:", err);
    res.status(500).send(`Failed to clear, ${err.message}`);
  }
});


/* ==============================
   STATIC FOLDERS
============================== */
app.use("/images", express.static(path.join(__dirname, "public/images")));
app.use("/videos", express.static(path.join(__dirname, "public/videos")));
app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));

/* ==============================
   START SERVER
============================== */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});

