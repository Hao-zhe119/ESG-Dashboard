const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const {
  DEFAULT_CONFIG,
  readRuntimeConfig,
  updateRuntimeConfig,
  getDefaultTimerRows
} = require("./config/dashboardConfig");
const app = express();

require('dotenv').config({ path: './databaseinfo.env' });
const RESET_PASSCODE = process.env.RESET_PASSCODE || "Reset@ESGDashboard!";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-key";
const OFFLINE_ADMIN_PASSWORD = process.env.OFFLINE_ADMIN_PASSWORD || RESET_PASSCODE;
const OFFLINE_ADMIN_USER = {
  id: 1,
  account: "No-XAMPP Test Admin",
  isOffline: true
};

/* ==============================
   SESSION SETUP
============================== */
app.use(
  session({
    secret: SESSION_SECRET,
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
   CAPTION JSON STORE
   Captions are stored in a local JSON file so no DB changes are needed.
   File: public/uploads/captions.json
   Structure: { "accountId_mediaId": { caption_text, caption_x, caption_y } }
============================== */
const CAPTIONS_FILE = path.join(__dirname, "public", "uploads", "captions.json");

function readCaptions() {
  try {
    if (!fs.existsSync(CAPTIONS_FILE)) return {};
    return JSON.parse(fs.readFileSync(CAPTIONS_FILE, "utf8") || "{}");
  } catch (_e) { return {}; }
}

function writeCaptions(data) {
  ensureDir(path.dirname(CAPTIONS_FILE));
  fs.writeFileSync(CAPTIONS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function mergeCaptionsIntoItems(items, accountId) {
  const captions = readCaptions();
  return items.map(item => {
    const key = accountId + "_" + item.id;
    const cap = captions[key] || {};
    return {
      ...item,
      caption_text:      cap.caption_text      || null,
      caption_x:         cap.caption_x         != null ? cap.caption_x         : 50,
      caption_y:         cap.caption_y         != null ? cap.caption_y         : 85,
      caption_font_size: cap.caption_font_size != null ? cap.caption_font_size : 24
    };
  });
}

/* ==============================
   MYSQL CONNECTION
============================== */
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

let databaseAvailable = false;

connection.connect((err) => {
  if (err) {
    databaseAvailable = false;
    console.error('MySQL connection error:', err);
  } else {
    databaseAvailable = true;
    console.log('Connected to MySQL as', process.env.DB_USER);
  }
});

connection.on("error", (err) => {
  databaseAvailable = false;
  console.error("MySQL runtime error:", err.message);
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

/**
 * Bump the dashboard data version. Open dashboard screens poll this number
 * (via GET /dashboard/data-version) and reload when it changes, so a newly
 * uploaded dataset shows up without anyone manually refreshing the display.
 */
function bumpDataVersion() {
  try {
    const updated = updateRuntimeConfig((config) => {
      config.dataVersion = (Number(config.dataVersion) || 0) + 1;
      return config;
    });
    console.log("Dashboard data version bumped to", updated.dataVersion);
    return updated.dataVersion;
  } catch (e) {
    console.warn("Could not bump dashboard data version:", e.message);
    return null;
  }
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
function getBuildingGroupsByPage() {
  const config = readRuntimeConfig();
  return config.buildingPageGroups || {};
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

let healthMonitorId = null;
let hibernateMonitorId = null;
let interactiveRevertMonitorId = null;
let latestHealthSnapshot = {
  status: "unknown",
  checkedAt: null,
  checks: {}
};

function boolFromRequest(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

async function canUseDatabase() {
  try {
    await db.query("SELECT 1 AS ok");
    databaseAvailable = true;
    return true;
  } catch (error) {
    databaseAvailable = false;
    return false;
  }
}

function getFallbackTimerRows() {
  return getDefaultTimerRows().map((row) => ({
    timer_id: row.page_number,
    page_number: row.page_number,
    page_name: `Page ${row.page_number}`,
    duration_seconds: row.duration_seconds
  }));
}

function buildTimerMap(rows) {
  const timerMap = {};
  (rows || []).forEach((timer) => {
    const pageNumber = parseInt(timer.page_number || timer.timer_id, 10);
    const durationSeconds = Number(timer.duration_seconds) || 30;
    if (!isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= 10) {
      timerMap[pageNumber] = {
        timer_id: Number(timer.timer_id || pageNumber),
        page_number: pageNumber,
        page_name: timer.page_name || `Page ${pageNumber}`,
        duration_seconds: durationSeconds,
        duration_ms: durationSeconds * 1000
      };
    }
  });
  return timerMap;
}

function emptyDashboardData() {
  return {
    allYears: [],
    latestYear: null,
    oldestYear: null,
    newestYear: null,
    overviewByYear: {},
    solarByYear: {},
    wasteByYear: {},
    overviewYear1Rows: [],
    overviewYear2Rows: [],
    solarYear1Months: [],
    solarYear2Months: [],
    wasteYear1Months: [],
    wasteYear2Months: [],
    buildingMonthly: {},
    buildingMonthlyByYear: {},
    buildingYearRanges: {}
  };
}

function isValidTimeString(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function normalizeHibernateDays(input, fallbackStart = "22:00", fallbackEnd = "07:00") {
  const source = input && typeof input === "object" ? input : {};
  return WEEKDAYS.reduce((days, day) => {
    const hasDay = source[day] && typeof source[day] === "object";
    const item = hasDay ? source[day] : {};
    days[day] = {
      enabled: hasDay ? boolFromRequest(item.enabled) : !["saturday", "sunday"].includes(day),
      startTime: isValidTimeString(item.startTime) ? item.startTime : fallbackStart,
      endTime: isValidTimeString(item.endTime) ? item.endTime : fallbackEnd
    };
    return days;
  }, {});
}

function normalizeHibernateProfile(input) {
  const name = String(input.name || "").trim();
  const startTime = String(input.startTime || input.start_time || "").trim();
  const endTime = String(input.endTime || input.end_time || "").trim();
  if (!name) throw new Error("Profile name is required");
  if (!isValidTimeString(startTime) || !isValidTimeString(endTime)) {
    throw new Error("Start and end time must use HH:MM format");
  }
  return { name, startTime, endTime, days: normalizeHibernateDays(input.days, startTime, endTime) };
}

function normalizeWakeDays(input, fallbackWake = "07:00") {
  const source = input && typeof input === "object" ? input : {};
  return WEEKDAYS.reduce((days, day) => {
    const hasDay = source[day] && typeof source[day] === "object";
    const item = hasDay ? source[day] : {};
    days[day] = {
      enabled: hasDay ? boolFromRequest(item.enabled) : !["saturday", "sunday"].includes(day),
      wakeTime: isValidTimeString(item.wakeTime) ? item.wakeTime : fallbackWake
    };
    return days;
  }, {});
}

function normalizeDashboardSettings(input) {
  return {
    dashboardMode: String(input.dashboardMode || input.dashboard_mode || "auto").toLowerCase() === "interactive" ? "interactive" : "auto",
    autoSwitchOnActivity: boolFromRequest(input.autoSwitchOnActivity),
    autoRevertEnabled: boolFromRequest(input.autoRevertEnabled),
    idleTimeoutMinutes: Math.max(1, Math.min(240, Number(input.idleTimeoutMinutes || input.idle_timeout_minutes || 15)))
  };
}

function defaultDashboardSettings() {
  const profile = (DEFAULT_CONFIG.dashboardSettingsProfiles || []).find((item) => item.id === "default");
  return normalizeDashboardSettings((profile && profile.settings) || {});
}

async function applyDashboardSettings(req, settings) {
  const accountId = req.session.user.id;
  if (req.session.user.isOffline || !(await canUseDatabase())) {
    updateRuntimeConfig((config) => {
      config.offlineDashboardMode = settings.dashboardMode;
      return config;
    });
  } else {
    await db.query(
      "UPDATE accounts SET dashboard_mode = ? WHERE id = ?",
      [settings.dashboardMode, accountId]
    );
  }
  return updateRuntimeConfig((config) => {
    config.interactiveMode.autoSwitchOnActivity = settings.autoSwitchOnActivity;
    config.interactiveMode.autoRevertEnabled = settings.autoRevertEnabled;
    config.interactiveMode.idleTimeoutMinutes = settings.idleTimeoutMinutes;
    config.interactiveMode.lastActivityAt = settings.dashboardMode === "interactive" ? new Date().toISOString() : null;
    return config;
  });
}

async function runOperationalScript(args, timeout = 15000) {
  const scriptPath = path.join(__dirname, "scripts", "process-control.ps1");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { timeout },
      (error, stdout, stderr) => {
        const output = String(stdout || stderr || "").trim();
        if (error) {
          error.message = `${error.message}${output ? `: ${output}` : ""}`;
          reject(error);
          return;
        }
        resolve(output);
      }
    );
  });
}

function runOperationalScriptDetached(args) {
  const scriptPath = path.join(__dirname, "scripts", "process-control.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
}

function normalizeTimerRows(rows) {
  return (rows || [])
    .map((row) => ({
      page_number: Number(row.page_number),
      page_name: row.page_name || `Page ${row.page_number}`,
      duration_seconds: Math.max(0, Number(row.duration_seconds) || 0)
    }))
    .filter((row) => Number.isFinite(row.page_number))
    .sort((a, b) => a.page_number - b.page_number);
}

async function getTimerRowsForAccount(accountId) {
  const [rows] = await db.query(
    `SELECT timer_id, page_number, page_name, duration_seconds
     FROM timers
     WHERE account_id = ?
     ORDER BY page_number ASC`,
    [accountId]
  );
  return normalizeTimerRows(rows);
}

async function upsertTimerRowsForAccount(accountId, timerRows) {
  const currentRows = await getTimerRowsForAccount(accountId);
  const pageNames = new Map(currentRows.map((row) => [row.page_number, row.page_name]));

  for (const row of normalizeTimerRows(timerRows)) {
    const pageNumber = Number(row.page_number);
    const seconds = Math.max(0, Number(row.duration_seconds) || 0);
    const pageName = row.page_name || pageNames.get(pageNumber) || `Page ${pageNumber}`;

    const [updateResult] = await db.query(
      `UPDATE timers
       SET duration_seconds = ?
       WHERE account_id = ? AND page_number = ?`,
      [seconds, accountId, pageNumber]
    );

    if (updateResult.affectedRows === 0) {
      await db.query(
        `INSERT INTO timers (account_id, page_number, page_name, duration_seconds)
         VALUES (?, ?, ?, ?)`,
        [accountId, pageNumber, pageName, seconds]
      );
    }
  }
}

async function runHealthCheck() {
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const memoryUsedPercent = totalMemoryBytes > 0
    ? Math.round(((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 100)
    : 0;
  const checks = {
    backend: { ok: true, message: "Express process is running", uptimeSeconds: Math.round(process.uptime()) },
    process: {
      ok: true,
      message: "Node process is responsive",
      pid: process.pid,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    hardware: {
      ok: memoryUsedPercent < 95,
      message: memoryUsedPercent < 95 ? "Basic hardware health is within limits" : "System memory usage is critically high",
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      cpuCores: os.cpus().length,
      cpuModel: os.cpus()[0] ? os.cpus()[0].model : "Unknown",
      loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
      uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      totalMemoryGb: Number((totalMemoryBytes / 1024 / 1024 / 1024).toFixed(1)),
      freeMemoryGb: Number((freeMemoryBytes / 1024 / 1024 / 1024).toFixed(1)),
      memoryUsedPercent
    },
    database: { ok: false, message: "Not checked" },
    dashboard: { ok: false, message: "Not checked" },
    noXamppTestMode: { ok: true, message: databaseAvailable ? "Database mode" : "No-XAMPP test fallback available" }
  };

  try {
    await db.query("SELECT 1 AS ok");
    checks.database = { ok: true, message: "Database connection is healthy" };
  } catch (error) {
    checks.database = { ok: false, message: error.message };
  }

  try {
    if (typeof fetch !== "function") {
      const [tables] = await db.query("SHOW TABLES LIKE 'timers'");
      checks.dashboard = {
        ok: Array.isArray(tables) && tables.length > 0,
        message: Array.isArray(tables) && tables.length > 0
          ? "Dashboard timer table is accessible"
          : "Dashboard timer table is missing"
      };
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
      clearTimeout(timeout);
      checks.dashboard = {
        ok: response.ok,
        message: response.ok ? "Dashboard route is accessible" : `Dashboard returned HTTP ${response.status}`
      };
    }
  } catch (error) {
    checks.dashboard = { ok: false, message: error.message };
  }

  if (process.platform === "win32") {
    try {
      const hardwareJson = await new Promise((resolve, reject) => {
        const command = [
          "$disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\" | Select-Object Size,FreeSpace;",
          "$battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining,BatteryStatus;",
          "[PSCustomObject]@{ disk=$disk; battery=$battery } | ConvertTo-Json -Compress -Depth 3"
        ].join(" ");
        execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 5000 }, (error, stdout) => {
          if (error) return reject(error);
          resolve(String(stdout || "{}").trim());
        });
      });
      const windowsHardware = JSON.parse(hardwareJson || "{}");
      const disk = windowsHardware.disk || {};
      const diskFreePercent = Number(disk.Size) > 0 ? Math.round((Number(disk.FreeSpace) / Number(disk.Size)) * 100) : null;
      checks.hardware.diskFreePercent = diskFreePercent;
      checks.hardware.diskFreeGb = Number(disk.FreeSpace) > 0 ? Number((Number(disk.FreeSpace) / 1024 / 1024 / 1024).toFixed(1)) : null;
      checks.hardware.battery = windowsHardware.battery || null;
      if (diskFreePercent !== null && diskFreePercent < 10) {
        checks.hardware.ok = false;
        checks.hardware.message = "System disk space is critically low";
      }
    } catch (error) {
      checks.hardware.windowsDetails = `Unavailable: ${error.message}`;
    }
  }

  const ok = Object.values(checks).every((check) => check.ok);
  latestHealthSnapshot = {
    status: ok ? "ok" : "degraded",
    checkedAt: new Date().toISOString(),
    checks
  };
  return latestHealthSnapshot;
}

function syncHealthMonitor() {
  const config = readRuntimeConfig();
  const enabled = !!config.automation.healthCheckEnabled;

  if (!enabled) {
    if (healthMonitorId) clearInterval(healthMonitorId);
    healthMonitorId = null;
    latestHealthSnapshot = {
      ...latestHealthSnapshot,
      status: "disabled",
      checkedAt: new Date().toISOString()
    };
    return;
  }

  if (healthMonitorId) clearInterval(healthMonitorId);
  runHealthCheck().catch((error) => {
    latestHealthSnapshot = { status: "degraded", checkedAt: new Date().toISOString(), checks: { monitor: { ok: false, message: error.message } } };
  });
  healthMonitorId = setInterval(async () => {
    const current = readRuntimeConfig();
    const scheduledTime = isValidTimeString(current.automation.healthCheckTime) ? current.automation.healthCheckTime : "08:00";
    const now = new Date();
    const today = now.toLocaleDateString("en-CA");
    const time = now.toTimeString().slice(0, 5);
    if (time !== scheduledTime || current.automation.lastScheduledHealthCheckDate === today) return;
    try {
      await runHealthCheck();
      updateRuntimeConfig((nextConfig) => {
        nextConfig.automation.lastScheduledHealthCheckDate = today;
        return nextConfig;
      });
    } catch (error) {
      latestHealthSnapshot = { status: "degraded", checkedAt: new Date().toISOString(), checks: { monitor: { ok: false, message: error.message } } };
    }
  }, 30000);
}

function syncHibernateMonitor() {
  if (hibernateMonitorId) clearInterval(hibernateMonitorId);
  hibernateMonitorId = setInterval(async () => {
    const config = readRuntimeConfig();
    if (!config.automation.autoHibernateEnabled) return;
    const now = new Date();
    const dayName = WEEKDAYS[now.getDay()];
    const schedule = config.automation.autoHibernateSchedule || {};
    const daySchedule = normalizeHibernateDays(schedule.days, schedule.startTime, schedule.endTime)[dayName];
    const time = now.toTimeString().slice(0, 5);
    const runKey = `${now.toLocaleDateString("en-CA")}-${dayName}-${time}`;
    if (!daySchedule.enabled || time !== daySchedule.startTime || config.automation.lastHibernateRunKey === runKey) return;

    const scriptPath = path.join(__dirname, "scripts", "hibernate.ps1");
    const args = ["-ExecutionPolicy", "Bypass", "-File", scriptPath];
    if (config.automation.autoHibernateDryRun !== false) args.push("-DryRun");
    execFile("powershell.exe", args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) console.error("Scheduled auto-hibernate failed:", error.message);
      else console.log(`[AUTO-HIBERNATE] ${runKey} - ${String(stdout || stderr || "").trim()}`);
    });
    updateRuntimeConfig((nextConfig) => {
      nextConfig.automation.lastHibernateRunKey = runKey;
      return nextConfig;
    });
  }, 30000);
}

function markInteractiveActivity() {
  updateRuntimeConfig((config) => {
    config.interactiveMode.lastActivityAt = new Date().toISOString();
    return config;
  });
}

async function revertInteractiveModeIfIdle(force = false) {
  const config = readRuntimeConfig();
  const interactiveConfig = config.interactiveMode || {};
  if (!interactiveConfig.autoRevertEnabled && !force) return false;

  const timeoutMs = Math.max(1, Number(interactiveConfig.idleTimeoutMinutes || 15)) * 60 * 1000;
  const lastActivityAt = interactiveConfig.lastActivityAt ? Date.parse(interactiveConfig.lastActivityAt) : Date.now();
  const idleMs = Date.now() - lastActivityAt;
  if (!force && idleMs < timeoutMs) return false;

  const [result] = await db.query(
    "UPDATE accounts SET dashboard_mode = 'auto' WHERE dashboard_mode = 'interactive'"
  );

  if (result.affectedRows > 0 || force) {
    updateRuntimeConfig((nextConfig) => {
      nextConfig.interactiveMode.lastActivityAt = null;
      return nextConfig;
    });
    return true;
  }

  return false;
}

function syncInteractiveRevertMonitor() {
  if (interactiveRevertMonitorId) clearInterval(interactiveRevertMonitorId);
  interactiveRevertMonitorId = setInterval(() => {
    revertInteractiveModeIfIdle(false).catch((error) => {
      console.error("Interactive auto-revert check failed:", error.message);
    });
  }, 30000);
}

/* ==============================
   ADMIN ROUTES
============================== */

app.post("/admin/dashboard-mode", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized - Please login.");

  try {
    await applyDashboardSettings(req, normalizeDashboardSettings(req.body || {}));
    res.redirect("/admin#sec-dashboard-settings");
  } catch (err) {
    console.error("Error saving dashboard mode:", err);
    res.status(500).send("Failed to save dashboard mode");
  }
});

app.post("/admin/dashboard-settings/default", requireAuth, async (req, res) => {
  try {
    const config = await applyDashboardSettings(req, defaultDashboardSettings());
    res.json({ ok: true, interactiveMode: config.interactiveMode, profile: (config.dashboardSettingsProfiles || [])[0] });
  } catch (error) {
    console.error("Failed to apply default dashboard settings:", error);
    res.status(500).json({ ok: false, error: "Failed to apply default dashboard settings" });
  }
});

app.post("/admin/dashboard-settings/profiles", requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Profile name is required" });
    if (name.toLowerCase() === "default dashboard settings") {
      return res.status(400).json({ ok: false, error: "Default profile name is reserved" });
    }

    const profile = {
      id: String(Date.now()),
      name,
      isDefault: false,
      isProtected: false,
      createdAt: new Date().toISOString(),
      settings: normalizeDashboardSettings(req.body.settings || req.body)
    };

    const config = updateRuntimeConfig((nextConfig) => {
      const profiles = Array.isArray(nextConfig.dashboardSettingsProfiles) ? nextConfig.dashboardSettingsProfiles : [];
      const protectedProfiles = profiles.filter((item) => item.isProtected || item.id === "default");
      const customProfiles = profiles.filter((item) => !(item.isProtected || item.id === "default"));
      nextConfig.dashboardSettingsProfiles = protectedProfiles
        .concat(customProfiles.filter((item) => item.name.toLowerCase() !== name.toLowerCase()))
        .concat(profile);
      return nextConfig;
    });

    res.json({ ok: true, profile, profiles: config.dashboardSettingsProfiles });
  } catch (error) {
    console.error("Failed to save dashboard settings profile:", error);
    res.status(500).json({ ok: false, error: "Failed to save dashboard settings profile" });
  }
});

app.post("/admin/dashboard-settings/profiles/:profile_id/load", requireAuth, async (req, res) => {
  try {
    const config = readRuntimeConfig();
    const profile = (config.dashboardSettingsProfiles || []).find((item) => item.id === String(req.params.profile_id));
    if (!profile) return res.status(404).json({ ok: false, error: "Dashboard settings profile not found" });
    const updated = await applyDashboardSettings(req, normalizeDashboardSettings(profile.settings || {}));
    res.json({ ok: true, profile, interactiveMode: updated.interactiveMode });
  } catch (error) {
    console.error("Failed to load dashboard settings profile:", error);
    res.status(500).json({ ok: false, error: "Failed to load dashboard settings profile" });
  }
});

app.delete("/admin/dashboard-settings/profiles/:profile_id", requireAuth, async (req, res) => {
  try {
    const profileId = String(req.params.profile_id);
    if (profileId === "default") {
      return res.status(400).json({ ok: false, error: "Default dashboard settings cannot be deleted" });
    }
    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.dashboardSettingsProfiles = (nextConfig.dashboardSettingsProfiles || [])
        .filter((item) => item.id === "default" || item.id !== profileId);
      return nextConfig;
    });
    res.json({ ok: true, profiles: config.dashboardSettingsProfiles });
  } catch (error) {
    console.error("Failed to delete dashboard settings profile:", error);
    res.status(500).json({ ok: false, error: "Failed to delete dashboard settings profile" });
  }
});

app.post("/admin/config/interactive-auto-revert", requireAuth, async (req, res) => {
  try {
    const enabled = boolFromRequest(req.body.enabled);
    const autoSwitchOnActivity = boolFromRequest(req.body.autoSwitchOnActivity);
    const idleTimeoutMinutes = Number(req.body.idleTimeoutMinutes || req.body.idle_timeout_minutes || 15);
    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.interactiveMode.autoSwitchOnActivity = autoSwitchOnActivity;
      nextConfig.interactiveMode.autoRevertEnabled = enabled;
      nextConfig.interactiveMode.idleTimeoutMinutes = Math.max(1, Math.min(240, idleTimeoutMinutes || 15));
      return nextConfig;
    });
    res.json({ ok: true, interactiveMode: config.interactiveMode });
  } catch (error) {
    console.error("Failed to update interactive auto-revert config:", error);
    res.status(500).json({ ok: false, error: "Failed to update interactive settings" });
  }
});

app.post("/dashboard/interactive-activity", async (req, res) => {
  try {
    const accountId = getAccountId(req);
    const mode = await getDashboardModeForAccount(accountId);
    const config = readRuntimeConfig();
    let switched = false;
    if (mode === "auto" && config.interactiveMode.autoSwitchOnActivity) {
      if (await canUseDatabase()) {
        await db.query("UPDATE accounts SET dashboard_mode = 'interactive' WHERE id = ?", [accountId]);
      } else {
        updateRuntimeConfig((nextConfig) => {
          nextConfig.offlineDashboardMode = "interactive";
          return nextConfig;
        });
      }
      switched = true;
    }
    if (mode === "interactive" || switched) markInteractiveActivity();
    res.json({ ok: true, switched, mode: switched ? "interactive" : mode });
  } catch (error) {
    res.status(500).json({ ok: false });
  }
});

app.post("/dashboard/interactive-revert", async (req, res) => {
  try {
    const reverted = await revertInteractiveModeIfIdle(false);
    res.json({ ok: true, reverted });
  } catch (error) {
    console.error("Failed to revert interactive mode:", error);
    res.status(500).json({ ok: false, error: "Failed to revert mode" });
  }
});

// POST /admin/timers/:timer_id - Update timer duration
app.post('/admin/timers/:timer_id(\\d+)', requireAuth, async (req, res) => {
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

    if (req.session.user.isOffline || !(await canUseDatabase())) {
      const timerPage = Number(timer_id);
      updateRuntimeConfig((config) => {
        config.defaultTimersSeconds[String(timerPage)] = seconds;
        return config;
      });
      return res.status(200).send("Offline timer updated successfully");
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

app.post("/admin/timers/apply-defaults", requireAuth, async (req, res) => {
  try {
    const config = readRuntimeConfig();
    if (!config.automation.applyDefaultTimingEnabled) {
      return res.status(403).json({ ok: false, error: "Apply Default Timing is disabled" });
    }

    let timers = getFallbackTimerRows();
    if (!(req.session.user.isOffline || !(await canUseDatabase()))) {
      const accountId = req.session.user.id;
      await upsertTimerRowsForAccount(accountId, getDefaultTimerRows());
      timers = await getTimerRowsForAccount(accountId);
    }
    res.json({ ok: true, timers });
  } catch (error) {
    console.error("Failed to apply default timers:", error);
    res.status(500).json({ ok: false, error: "Failed to apply default timers" });
  }
});

app.get("/admin/timer-profiles/json", requireAuth, async (req, res) => {
  const config = readRuntimeConfig();
  res.json({ ok: true, profiles: config.timerProfiles || [] });
});

app.post("/admin/timer-profiles", requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Profile name is required" });

    const submittedTimers = Array.isArray(req.body.timers) ? normalizeTimerRows(req.body.timers) : [];
    const timers = submittedTimers.length > 0
      ? submittedTimers
      : (req.session.user.isOffline || !(await canUseDatabase()) ? getFallbackTimerRows() : await getTimerRowsForAccount(req.session.user.id));
    const profile = {
      id: String(Date.now()),
      name,
      createdAt: new Date().toISOString(),
      timers
    };

    const config = updateRuntimeConfig((nextConfig) => {
      const profiles = Array.isArray(nextConfig.timerProfiles) ? nextConfig.timerProfiles : [];
      nextConfig.timerProfiles = profiles.filter((item) => item.name.toLowerCase() !== name.toLowerCase());
      nextConfig.timerProfiles.push(profile);
      return nextConfig;
    });

    res.json({ ok: true, profile, profiles: config.timerProfiles });
  } catch (error) {
    console.error("Failed to save timer profile:", error);
    res.status(500).json({ ok: false, error: "Failed to save timer profile" });
  }
});

app.post("/admin/timer-profiles/:profile_id/load", requireAuth, async (req, res) => {
  try {
    const config = readRuntimeConfig();
    const profile = (config.timerProfiles || []).find((item) => item.id === String(req.params.profile_id));
    if (!profile) return res.status(404).json({ ok: false, error: "Timer profile not found" });

    let timers = normalizeTimerRows(profile.timers || []);
    if (req.session.user.isOffline || !(await canUseDatabase())) {
      updateRuntimeConfig((nextConfig) => {
        timers.forEach((timer) => {
          nextConfig.defaultTimersSeconds[String(timer.page_number)] = Number(timer.duration_seconds) || 0;
        });
        return nextConfig;
      });
      timers = getFallbackTimerRows();
    } else {
      await upsertTimerRowsForAccount(req.session.user.id, profile.timers || []);
      timers = await getTimerRowsForAccount(req.session.user.id);
    }
    res.json({ ok: true, profile, timers });
  } catch (error) {
    console.error("Failed to load timer profile:", error);
    res.status(500).json({ ok: false, error: "Failed to load timer profile" });
  }
});

app.delete("/admin/timer-profiles/:profile_id", requireAuth, async (req, res) => {
  try {
    const profileId = String(req.params.profile_id);
    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.timerProfiles = (nextConfig.timerProfiles || []).filter((item) => item.id !== profileId);
      return nextConfig;
    });
    res.json({ ok: true, profiles: config.timerProfiles });
  } catch (error) {
    console.error("Failed to delete timer profile:", error);
    res.status(500).json({ ok: false, error: "Failed to delete timer profile" });
  }
});

app.post("/admin/automation/toggle", requireAuth, async (req, res) => {
  try {
    const key = String(req.body.key || "");
    const allowedKeys = new Set(["applyDefaultTimingEnabled", "autoHibernateEnabled", "healthCheckEnabled"]);
    if (!allowedKeys.has(key)) return res.status(400).json({ ok: false, error: "Invalid automation setting" });

    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.automation[key] = boolFromRequest(req.body.enabled);
      return nextConfig;
    });

    if (key === "healthCheckEnabled") syncHealthMonitor();

    res.json({
      ok: true,
      automation: config.automation,
      health: latestHealthSnapshot,
      hibernateScript: path.join(__dirname, "scripts", "hibernate.ps1")
    });
  } catch (error) {
    console.error("Failed to update automation toggle:", error);
    res.status(500).json({ ok: false, error: "Failed to update automation setting" });
  }
});

app.post("/admin/automation/hibernate-settings", requireAuth, async (req, res) => {
  try {
    const startTime = String(req.body.startTime || req.body.start_time || "22:00");
    const endTime = String(req.body.endTime || req.body.end_time || "07:00");
    if (!isValidTimeString(startTime) || !isValidTimeString(endTime)) {
      return res.status(400).json({ ok: false, error: "Start and end time must use HH:MM format" });
    }
    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.automation.autoHibernateDryRun = true;
      nextConfig.automation.autoHibernateSchedule = {
        ...(nextConfig.automation.autoHibernateSchedule || {}),
        startTime,
        endTime,
        days: normalizeHibernateDays(req.body.days, startTime, endTime)
      };
      return nextConfig;
    });
    res.json({ ok: true, automation: config.automation });
  } catch (error) {
    console.error("Failed to update auto-hibernate settings:", error);
    res.status(500).json({ ok: false, error: "Failed to update auto-hibernate settings" });
  }
});

app.post("/admin/automation/wake-settings", requireAuth, async (req, res) => {
  try {
    const wakeTime = String(req.body.wakeTime || req.body.wake_time || "07:00");
    if (!isValidTimeString(wakeTime)) {
      return res.status(400).json({ ok: false, error: "Wake time must use HH:MM format" });
    }
    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.automation.autoWakeEnabled = boolFromRequest(req.body.enabled);
      nextConfig.automation.autoWakeSchedule = {
        ...(nextConfig.automation.autoWakeSchedule || {}),
        wakeTime,
        days: normalizeWakeDays(req.body.days, wakeTime)
      };
      return nextConfig;
    });
    res.json({ ok: true, automation: config.automation });
  } catch (error) {
    console.error("Failed to update auto-wake settings:", error);
    res.status(500).json({ ok: false, error: "Failed to update auto-wake settings" });
  }
});

app.post("/admin/automation/hibernate-profiles", requireAuth, async (req, res) => {
  try {
    const normalized = normalizeHibernateProfile(req.body || {});
    const profile = {
      id: String(Date.now()),
      name: normalized.name,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      days: normalized.days,
      isDefault: false,
      createdAt: new Date().toISOString()
    };
    const config = updateRuntimeConfig((nextConfig) => {
      const profiles = Array.isArray(nextConfig.automation.autoHibernateProfiles)
        ? nextConfig.automation.autoHibernateProfiles
        : [];
      nextConfig.automation.autoHibernateProfiles = profiles
        .filter((item) => item.name.toLowerCase() !== profile.name.toLowerCase())
        .concat(profile);
      return nextConfig;
    });
    res.json({ ok: true, profile, profiles: config.automation.autoHibernateProfiles });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/automation/hibernate-profiles/:profile_id/load", requireAuth, async (req, res) => {
  try {
    const profileId = String(req.params.profile_id);
    const config = updateRuntimeConfig((nextConfig) => {
      const profiles = nextConfig.automation.autoHibernateProfiles || [];
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error("Hibernate profile not found");
      nextConfig.automation.autoHibernateSchedule = {
        startTime: profile.startTime,
        endTime: profile.endTime,
        days: normalizeHibernateDays(profile.days, profile.startTime, profile.endTime),
        activeProfileId: profile.id
      };
      return nextConfig;
    });
    res.json({ ok: true, automation: config.automation });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post("/admin/automation/hibernate-profiles/:profile_id/default", requireAuth, async (req, res) => {
  try {
    const profileId = String(req.params.profile_id);
    const config = updateRuntimeConfig((nextConfig) => {
      const profiles = nextConfig.automation.autoHibernateProfiles || [];
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error("Hibernate profile not found");
      nextConfig.automation.autoHibernateProfiles = profiles.map((item) => ({
        ...item,
        isDefault: item.id === profileId
      }));
      nextConfig.automation.autoHibernateSchedule = {
        startTime: profile.startTime,
        endTime: profile.endTime,
        days: normalizeHibernateDays(profile.days, profile.startTime, profile.endTime),
        activeProfileId: profile.id
      };
      return nextConfig;
    });
    res.json({ ok: true, automation: config.automation });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.delete("/admin/automation/hibernate-profiles/:profile_id", requireAuth, async (req, res) => {
  try {
    const profileId = String(req.params.profile_id);
    if (profileId === "default") {
      return res.status(400).json({ ok: false, error: "Default profile cannot be deleted" });
    }
    const config = updateRuntimeConfig((nextConfig) => {
      nextConfig.automation.autoHibernateProfiles = (nextConfig.automation.autoHibernateProfiles || [])
        .filter((item) => item.id !== profileId);
      return nextConfig;
    });
    res.json({ ok: true, profiles: config.automation.autoHibernateProfiles });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Failed to delete hibernate profile" });
  }
});

app.post("/admin/automation/hibernate-dry-run", requireAuth, async (req, res) => {
  try {
    const config = readRuntimeConfig();
    if (!config.automation.autoHibernateEnabled) {
      return res.status(400).json({ ok: false, error: "Turn on Auto-Hibernate before running the dry run" });
    }

    const now = new Date().toISOString();
    const scriptPath = path.join(__dirname, "scripts", "hibernate.ps1");
    const schedule = config.automation.autoHibernateSchedule || {};
    const startTime = isValidTimeString(schedule.startTime) ? schedule.startTime : "22:00";
    const endTime = isValidTimeString(schedule.endTime) ? schedule.endTime : "07:00";
    const scriptOutput = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-ExecutionPolicy", "Bypass", "-File", scriptPath, "-DryRun"],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            error.message = `${error.message}${stderr ? `: ${stderr}` : ""}`;
            reject(error);
            return;
          }
          resolve(String(stdout || stderr || "").trim());
        }
      );
    });
    const updated = updateRuntimeConfig((nextConfig) => {
      nextConfig.automation.autoHibernateDryRun = true;
      nextConfig.automation.lastHibernateDryRunAt = now;
      return nextConfig;
    });

    console.log(`[AUTO-HIBERNATE DRY RUN] ${now} - hibernate at ${startTime}, wake at ${endTime} - ${scriptOutput}`);
    res.json({
      ok: true,
      dryRun: true,
      checkedAt: now,
      startTime,
      endTime,
      message: `Dry run successful. Hibernate at ${startTime}, wake at ${endTime}. No OS hibernate command was executed.`,
      scriptOutput,
      hibernateScript: scriptPath,
      automation: updated.automation
    });
  } catch (error) {
    console.error("Auto-hibernate dry run failed:", error);
    res.status(500).json({ ok: false, error: "Auto-hibernate dry run failed" });
  }
});

app.post("/admin/automation/hibernate-now", requireAuth, async (req, res) => {
  try {
    const scriptPath = path.join(__dirname, "scripts", "hibernate.ps1");
    res.json({
      ok: true,
      message: "Real Windows hibernate requested. The laptop may sleep immediately."
    });
    setTimeout(() => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ExecuteHibernate"],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();
    }, 750);
  } catch (error) {
    console.error("Immediate hibernate failed:", error);
  }
});

app.get("/admin/automation/shutdown-start-capability", requireAuth, async (req, res) => {
  res.json({
    ok: true,
    supportedByAppScript: false,
    summary: "A normal app script cannot power on a fully shut-down PC.",
    options: [
      "Use BIOS/UEFI RTC alarm or Power On By RTC, if the laptop/PC supports it.",
      "Use Wake-on-LAN from another powered device on the same network, if BIOS and network adapter support it.",
      "Use Windows Task Scheduler wake timers only for sleep/hibernate, not full shutdown."
    ]
  });
});

app.post("/admin/automation/wake-dry-run", requireAuth, async (req, res) => {
  try {
    const config = readRuntimeConfig();
    const wakeSchedule = config.automation.autoWakeSchedule || {};
    const wakeTime = isValidTimeString(wakeSchedule.wakeTime) ? wakeSchedule.wakeTime : "07:00";
    const scriptPath = path.join(__dirname, "scripts", "wake-dashboard.ps1");
    const scriptOutput = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-WakeTime", wakeTime, "-DryRun"],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            error.message = `${error.message}${stderr ? `: ${stderr}` : ""}`;
            reject(error);
            return;
          }
          resolve(String(stdout || stderr || "").trim());
        }
      );
    });
    const updated = updateRuntimeConfig((nextConfig) => {
      nextConfig.automation.lastWakeTaskDryRunAt = new Date().toISOString();
      return nextConfig;
    });
    res.json({
      ok: true,
      dryRun: true,
      wakeTime,
      message: `Wake task dry run successful. The app would be started at ${wakeTime}.`,
      scriptOutput,
      automation: updated.automation
    });
  } catch (error) {
    console.error("Wake task dry run failed:", error);
    res.status(500).json({ ok: false, error: "Wake task dry run failed" });
  }
});

app.post("/admin/automation/wake-register", requireAuth, async (req, res) => {
  try {
    const config = readRuntimeConfig();
    if (!config.automation.autoWakeEnabled) {
      return res.status(400).json({ ok: false, error: "Turn on Auto-Wake before registering the Windows wake task" });
    }
    const wakeSchedule = config.automation.autoWakeSchedule || {};
    const wakeTime = isValidTimeString(wakeSchedule.wakeTime) ? wakeSchedule.wakeTime : "07:00";
    const scriptPath = path.join(__dirname, "scripts", "wake-dashboard.ps1");
    const scriptOutput = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-WakeTime", wakeTime],
        { timeout: 15000 },
        (error, stdout, stderr) => {
          if (error) {
            error.message = `${error.message}${stderr ? `: ${stderr}` : ""}`;
            reject(error);
            return;
          }
          resolve(String(stdout || stderr || "").trim());
        }
      );
    });
    res.json({
      ok: true,
      wakeTime,
      message: `Windows wake task registered for ${wakeTime}.`,
      scriptOutput
    });
  } catch (error) {
    console.error("Wake task registration failed:", error);
    res.status(500).json({ ok: false, error: "Wake task registration failed. Run the app as administrator or use dry run first." });
  }
});

app.get("/admin/health/json", requireAuth, async (req, res) => {
  const config = readRuntimeConfig();
  if (config.automation.healthCheckEnabled) {
    await runHealthCheck();
  }
  let processStatus = {};
  try {
    const [appStatus, databaseStatus] = await Promise.all([
      runOperationalScript(["-Target", "app", "-Action", "status"], 8000),
      runOperationalScript(["-Target", "database", "-Action", "status"], 8000)
    ]);
    processStatus = { app: appStatus, database: databaseStatus };
  } catch (error) {
    processStatus = { error: error.message };
  }
  res.json({
    ok: latestHealthSnapshot.status === "ok",
    enabled: !!config.automation.healthCheckEnabled,
    health: latestHealthSnapshot,
    processes: processStatus
  });
});

app.post("/admin/automation/health-settings", requireAuth, async (req, res) => {
  const healthCheckTime = String(req.body.healthCheckTime || "").trim();
  if (!isValidTimeString(healthCheckTime)) {
    return res.status(400).json({ ok: false, error: "Health check time must use HH:MM format" });
  }
  const config = updateRuntimeConfig((nextConfig) => {
    nextConfig.automation.healthCheckTime = healthCheckTime;
    return nextConfig;
  });
  syncHealthMonitor();
  res.json({ ok: true, automation: config.automation });
});

app.post("/admin/process-control", requireAuth, async (req, res) => {
  const target = String(req.body.target || "");
  const action = String(req.body.action || "");
  const allowedTargets = new Set(["app", "database"]);
  const allowedActions = new Set(["status", "start", "stop", "restart"]);
  if (!allowedTargets.has(target) || !allowedActions.has(action)) {
    return res.status(400).json({ ok: false, error: "Invalid process control request" });
  }

  try {
    if (target === "app" && (action === "stop" || action === "restart")) {
      res.json({ ok: true, target, action, output: `Application ${action} requested. This admin page may disconnect briefly.` });
      setTimeout(() => {
        runOperationalScriptDetached(["-Target", target, "-Action", action]);
      }, 500);
      return;
    }
    const output = await runOperationalScript(["-Target", target, "-Action", action], action === "restart" ? 25000 : 15000);
    res.json({ ok: true, target, action, output });
  } catch (error) {
    console.error("Process control failed:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/health", async (req, res) => {
  const config = readRuntimeConfig();
  const status = config.automation.healthCheckEnabled ? latestHealthSnapshot.status : "disabled";
  res.status(status === "degraded" ? 503 : 200).json({
    status,
    checkedAt: latestHealthSnapshot.checkedAt
  });
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
  const runtimeConfig = readRuntimeConfig();
  const dbOnline = await canUseDatabase();

  const queryMode = req.query.mode ? String(req.query.mode).toLowerCase() : null;
  const dbMode = dbOnline ? await getDashboardModeForAccount(accountId) : (runtimeConfig.offlineDashboardMode || "auto");
  const canOverrideMode = !!(req.session && req.session.user);
  const effectiveMode =
    canOverrideMode && queryMode === "interactive" ? "interactive" :
    (canOverrideMode && queryMode === "auto" ? "auto" : dbMode);
  const dashboardMode = effectiveMode;
  const accessProfile = req.session.user ? "admin" : "public";

  let timers = dbOnline ? [] : getFallbackTimerRows();
  let timersByTimerId = buildTimerMap(timers);

  if (!dbOnline) {
    return res.render("index", {
      user: req.session.user || null,
      dashboardData: emptyDashboardData(),
      dashboardMode,
      mediaImages: [],
      mediaVideos: [],
      buildingLabelMap: {},
      buildingCardLabelMap: {},
      timers,
      timersByTimerId,
      runtimeConfig,
      accessProfile,
      offlineMode: true
    });
  }

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
      Object.values(getBuildingGroupsByPage()).forEach((list) => {
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
      mediaImages = mergeCaptionsIntoItems(imgRows || [], accountId);
      mediaVideos = mergeCaptionsIntoItems(vidRows || [], accountId);
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
          `SELECT timer_id, page_number, page_name, duration_seconds 
           FROM timers 
           WHERE account_id = ? 
           ORDER BY timer_id ASC`,
          [accountId]
        );
        
        if (Array.isArray(timerRows)) {
          timers = timerRows;
          
          timersByTimerId = buildTimerMap(timers);
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
      timersByTimerId: timersByTimerId || {},
      runtimeConfig,
      accessProfile
    });
  } catch (err) {
    console.error("Error loading dashboard:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Lightweight version probe so open dashboard screens can detect a fresh
// upload and reload themselves. Returns the current data version number.
app.get("/dashboard/data-version", (req, res) => {
  const version = Number(readRuntimeConfig().dataVersion) || 0;
  res.json({ version });
});



/* ==============================
   BUILDING CONTROLS
============================== */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    const wantsJson =
      req.accepts(["json", "html"]) === "json" ||
      String(req.get("content-type") || "").includes("application/json");
    if (wantsJson) {
      return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
    }
    return res.status(401).send("Unauthorized - Please login.");
  }
  next();
}

function renderOfflineAdmin(req, res) {
  const runtimeConfig = readRuntimeConfig();
  const timers = getFallbackTimerRows();
  res.render('admin', {
    buildings: [],
    buildingsMeta: [],
    allYears: [],
    electricityYears: [],
    waterYears: [],
    mediaImages: [],
    mediaVideos: [],
    dashboardMode: runtimeConfig.offlineDashboardMode || 'auto',
    timers,
    runtimeConfig,
    automationConfig: runtimeConfig.automation,
    interactiveConfig: runtimeConfig.interactiveMode,
    dashboardSettingsProfiles: runtimeConfig.dashboardSettingsProfiles || [],
    timerProfiles: runtimeConfig.timerProfiles || [],
    defaultTimersSeconds: runtimeConfig.defaultTimersSeconds || {},
    healthSnapshot: {
      ...latestHealthSnapshot,
      status: "offline",
      checks: {
        database: { ok: false, message: "MySQL/XAMPP is not running. Admin config is using JSON test fallback." }
      }
    },
    buildingsLoadError: true
  });
}

app.get("/buildingControls", async (req, res) => {
  const accountId = getAccountId(req);

  const queryMode = req.query.mode ? String(req.query.mode).toLowerCase() : null;
  const dbMode = await getDashboardModeForAccount(accountId);
  const canOverrideMode = !!(req.session && req.session.user);
  const dashboardMode =
    canOverrideMode && queryMode === "interactive" ? "interactive" :
    (canOverrideMode && queryMode === "auto" ? "auto" : dbMode);

  if (String(dashboardMode).toLowerCase() !== "interactive") {
    return res.status(404).send("Not available in auto mode");
  }

  const buildings = Array.from(
    new Set(Object.values(getBuildingGroupsByPage() || {}).flat().filter(Boolean))
  );

  res.render("buildingControls", {
    user: req.session.user || null,
    dashboardMode,
    buildings
  });
});

// Temporary route for interactive map page
app.get('/interactivemap', (req, res) => {res.render('interactivemap');});

/* ==============================
   LOCAL LLM ASSISTANT (Ollama)
   ------------------------------
   Talks to a locally-running Ollama server. No data leaves the machine.
   Configurable via databaseinfo.env if the model/host ever changes.
============================== */
const OLLAMA_HOST  = process.env.OLLAMA_HOST  || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

const ASSISTANT_SYSTEM_PROMPT =
  "You are the assistant for the Republic Polytechnic (RP) ESG Sustainability Dashboard. " +
  "ESG stands for Environmental, Social, and Governance. Help visitors understand " +
  "sustainability topics such as electricity use, water use, solar energy, and waste. " +
  "Keep answers short, clear, and friendly. " +
  "A section titled 'REAL DASHBOARD DATA' is provided below with the actual figures. " +
  "When asked about specific numbers, buildings, years, or trends, use ONLY the figures in that " +
  "section. Do NOT invent or estimate numbers. If a requested figure is not in the data, say you " +
  "don't have that figure rather than guessing.";

// ---- Real ESG data context (the model phrases these; it never computes them) ----
const fmtNum = n => Number(n || 0).toLocaleString("en-US");
let _esgCtxCache = { ts: 0, accountId: null, text: "" };
const ESG_CTX_TTL_MS = 5 * 60 * 1000; // refresh at most every 5 min

async function buildEsgDataContext(accountId) {
  // Serve from cache when fresh (data only changes on admin upload)
  if (_esgCtxCache.text &&
      _esgCtxCache.accountId === accountId &&
      (Date.now() - _esgCtxCache.ts) < ESG_CTX_TTL_MS) {
    return _esgCtxCache.text;
  }

  const [years, elecYear, elecTop, waterYear, solarYear, wasteYear, bldgCount] = await Promise.all([
    db.query("SELECT year FROM year_range WHERE account_id=? ORDER BY year", [accountId]),
    db.query("SELECT YEAR(bill_month) y, SUM(total_bill) v FROM total_ebills WHERE account_id=? GROUP BY y ORDER BY y", [accountId]),
    db.query("SELECT building_name, SUM(bill_amount) v FROM building_ebills WHERE account_id=? GROUP BY building_name ORDER BY v DESC LIMIT 6", [accountId]),
    db.query("SELECT YEAR(bill_month) y, SUM(portable_water) p, SUM(recycled_water) r FROM total_waterusage WHERE account_id=? GROUP BY y ORDER BY y", [accountId]),
    db.query("SELECT YEAR(bill_month) y, SUM(urban_renewables) u, SUM(green_house) g FROM total_solardata WHERE account_id=? GROUP BY y ORDER BY y", [accountId]),
    db.query("SELECT YEAR(bill_month) y, SUM(general_kg) gen, SUM(recyclable_kg) rec FROM total_wastedata WHERE account_id=? GROUP BY y ORDER BY y", [accountId]),
    db.query("SELECT COUNT(*) n FROM building_info WHERE account_id=?", [accountId]),
  ]);

  const yearList = years[0].map(r => r.year);
  const L = [];
  L.push("===== REAL DASHBOARD DATA =====");
  L.push("Units: electricity & solar in kWh, water in m³ (cubic metres), waste in kg.");
  L.push("Reporting years available: " + (yearList.length ? yearList.join(", ") : "none") + ". " +
         "Buildings tracked: " + fmtNum(bldgCount[0][0].n) + ".");

  L.push("\nELECTRICITY USE — total campus (kWh):");
  elecYear[0].forEach(r => L.push(`  ${r.y}: ${fmtNum(r.v)} kWh`));

  L.push("Top buildings by electricity use (all available years combined):");
  elecTop[0].forEach((r, i) => L.push(`  ${i + 1}. ${r.building_name}: ${fmtNum(r.v)} kWh`));

  L.push("\nWATER USE — total campus (m³):");
  waterYear[0].forEach(r => {
    const tot = Number(r.p || 0) + Number(r.r || 0);
    L.push(`  ${r.y}: ${fmtNum(tot)} m³ total (potable ${fmtNum(r.p)}, recycled ${fmtNum(r.r)})`);
  });

  L.push("\nSOLAR ENERGY GENERATED (kWh):");
  solarYear[0].forEach(r => {
    const tot = Number(r.u || 0) + Number(r.g || 0);
    L.push(`  ${r.y}: ${fmtNum(tot)} kWh (urban renewables ${fmtNum(r.u)}, green house ${fmtNum(r.g)})`);
  });

  L.push("\nWASTE (kg):");
  wasteYear[0].forEach(r => {
    const gen = Number(r.gen || 0), rec = Number(r.rec || 0), tot = gen + rec;
    if (tot === 0) return; // skip years with no waste data yet
    const pct = ((rec / tot) * 100).toFixed(1);
    L.push(`  ${r.y}: general ${fmtNum(gen)} kg, recyclable ${fmtNum(rec)} kg (recycled share ${pct}%)`);
  });

  L.push("===== END DATA =====");

  const text = L.join("\n");
  _esgCtxCache = { ts: Date.now(), accountId, text };
  return text;
}

// Render the standalone chat page
app.get("/assistant", (req, res) => {
  res.render("assistant", { model: OLLAMA_MODEL });
});

// Streaming chat endpoint: browser -> here -> Ollama -> stream tokens back
app.post("/api/chat", async (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];

    // Keep only valid user/assistant turns, cap history + length to stay fast & safe
    const history = incoming
      .filter(m => m && typeof m.content === "string" &&
                   (m.role === "user" || m.role === "assistant") &&
                   m.content.trim().length > 0)
      .slice(-10)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

    if (history.length === 0) {
      return res.status(400).json({ error: "No message provided." });
    }

    // Build the system prompt with the account's real ESG figures injected.
    let systemContent = ASSISTANT_SYSTEM_PROMPT;
    try {
      const dataContext = await buildEsgDataContext(getAccountId(req));
      systemContent += "\n\n" + dataContext;
    } catch (e) {
      console.error("[/api/chat] could not load ESG data context:", e.message);
      // Fall back to the general assistant without live data rather than failing.
    }

    const messages = [{ role: "system", content: systemContent }, ...history];

    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true })
    });

    if (!ollamaRes.ok || !ollamaRes.body) {
      return res.status(502).json({ error: "The assistant model did not respond. Is Ollama running?" });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    // Ollama streams newline-delimited JSON; forward only the text tokens.
    let buffer = "";
    for await (const chunk of ollamaRes.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep any partial line for the next chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.message && obj.message.content) res.write(obj.message.content);
        } catch (_) { /* ignore non-JSON keep-alive lines */ }
      }
    }
    res.end();
  } catch (err) {
    console.error("[/api/chat] error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Assistant unavailable. Make sure Ollama is running (ollama serve)." });
    } else {
      res.end();
    }
  }
});

/* ==============================
   ADMIN: EXPORT ALL DATA TO EXCEL
   ------------------------------
   One multi-sheet .xlsx with every ESG dataset for the account. No AI involved.
============================== */
app.get("/admin/export-excel", requireAuth, async (req, res) => {
  try {
    const accountId = getAccountId(req);
    const ym = d => (d instanceof Date ? d.toISOString().slice(0, 7) : String(d || "").slice(0, 7)); // YYYY-MM
    const num = v => (v == null ? null : Number(v));

    // Pull every dataset for this account
    const [
      [elecYear], [waterYear], [solarYear], [wasteYear],
      [totElec], [bldgElec], [totWater], [bldgWater],
      [solar], [waste], [buildings]
    ] = await Promise.all([
      db.query("SELECT YEAR(bill_month) Year, ROUND(SUM(total_bill)) `Electricity (kWh)` FROM total_ebills WHERE account_id=? GROUP BY Year ORDER BY Year", [accountId]),
      db.query("SELECT YEAR(bill_month) Year, ROUND(SUM(portable_water)) `Potable Water (m3)`, ROUND(SUM(recycled_water)) `Recycled Water (m3)` FROM total_waterusage WHERE account_id=? GROUP BY Year ORDER BY Year", [accountId]),
      db.query("SELECT YEAR(bill_month) Year, ROUND(SUM(urban_renewables)) `Urban Renewables (kWh)`, ROUND(SUM(green_house)) `Green House (kWh)` FROM total_solardata WHERE account_id=? GROUP BY Year ORDER BY Year", [accountId]),
      db.query("SELECT YEAR(bill_month) Year, ROUND(SUM(general_kg)) `General (kg)`, ROUND(SUM(recyclable_kg)) `Recyclable (kg)` FROM total_wastedata WHERE account_id=? GROUP BY Year ORDER BY Year", [accountId]),
      db.query("SELECT bill_month, total_bill FROM total_ebills WHERE account_id=? ORDER BY bill_month", [accountId]),
      db.query("SELECT building_name, bill_month, bill_amount FROM building_ebills WHERE account_id=? ORDER BY building_name, bill_month", [accountId]),
      db.query("SELECT bill_month, portable_water, recycled_water FROM total_waterusage WHERE account_id=? ORDER BY bill_month", [accountId]),
      db.query("SELECT building_name, bill_month, water_used FROM building_waterusage WHERE account_id=? ORDER BY building_name, bill_month", [accountId]),
      db.query("SELECT bill_month, urban_renewables, green_house FROM total_solardata WHERE account_id=? ORDER BY bill_month", [accountId]),
      db.query("SELECT bill_month, general_kg, recyclable_kg, general_percent, recyclable_percent FROM total_wastedata WHERE account_id=? ORDER BY bill_month", [accountId]),
      db.query("SELECT building_name, `desc`, display_label, card_label, elec_startyear, elec_endyear, water_startyear, water_endyear FROM building_info WHERE account_id=? ORDER BY building_name", [accountId]),
    ]);

    // Build a yearly Summary sheet (recycled share computed in code = exact)
    const years = new Map();
    const touch = y => { if (!years.has(y)) years.set(y, { Year: y }); return years.get(y); };
    elecYear.forEach(r => { touch(r.Year)["Electricity (kWh)"] = num(r["Electricity (kWh)"]); });
    waterYear.forEach(r => {
      const row = touch(r.Year);
      row["Potable Water (m3)"]  = num(r["Potable Water (m3)"]);
      row["Recycled Water (m3)"] = num(r["Recycled Water (m3)"]);
    });
    solarYear.forEach(r => {
      const row = touch(r.Year);
      row["Solar Generated (kWh)"] = num(r["Urban Renewables (kWh)"]) + num(r["Green House (kWh)"]);
    });
    wasteYear.forEach(r => {
      const row = touch(r.Year);
      const g = num(r["General (kg)"]) || 0, rc = num(r["Recyclable (kg)"]) || 0;
      row["Waste General (kg)"]   = g;
      row["Waste Recyclable (kg)"] = rc;
      row["Recycled Share (%)"]   = (g + rc) ? Number(((rc / (g + rc)) * 100).toFixed(1)) : 0;
    });
    const summaryCols = ["Electricity (kWh)", "Potable Water (m3)", "Recycled Water (m3)",
                         "Solar Generated (kWh)", "Waste General (kg)", "Waste Recyclable (kg)"];
    const summary = Array.from(years.values())
      .filter(r => summaryCols.some(k => Number(r[k]) > 0)) // drop years with no data (e.g. empty 2026)
      .sort((a, b) => a.Year - b.Year);

    // Shape detail sheets with clean, formatted columns
    const sElecTot  = totElec.map(r  => ({ Month: ym(r.bill_month), "Electricity (kWh)": num(r.total_bill) }));
    const sElecBldg = bldgElec.map(r => ({ Building: r.building_name, Month: ym(r.bill_month), "Electricity (kWh)": num(r.bill_amount) }));
    const sWaterTot = totWater.map(r => ({ Month: ym(r.bill_month), "Potable (m3)": num(r.portable_water), "Recycled (m3)": num(r.recycled_water) }));
    const sWaterBl  = bldgWater.map(r => ({ Building: r.building_name, Month: ym(r.bill_month), "Water Used (m3)": num(r.water_used) }));
    const sSolar    = solar.map(r    => ({ Month: ym(r.bill_month), "Urban Renewables (kWh)": num(r.urban_renewables), "Green House (kWh)": num(r.green_house) }));
    const sWaste    = waste.map(r    => ({ Month: ym(r.bill_month), "General (kg)": num(r.general_kg), "Recyclable (kg)": num(r.recyclable_kg), "General %": num(r.general_percent), "Recyclable %": num(r.recyclable_percent) }));
    const sBldg     = buildings.map(r => ({ Building: r.building_name, Description: r.desc, "Display Label": r.display_label, "Card Label": r.card_label, "Elec Start": r.elec_startyear, "Elec End": r.elec_endyear, "Water Start": r.water_startyear, "Water End": r.water_endyear }));

    const wb = XLSX.utils.book_new();
    const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name);
    add(summary,   "Summary by Year");
    add(sElecTot,  "Electricity Total");
    add(sElecBldg, "Electricity by Building");
    add(sWaterTot, "Water Total");
    add(sWaterBl,  "Water by Building");
    add(sSolar,    "Solar");
    add(sWaste,    "Waste");
    add(sBldg,     "Buildings");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="RP_ESG_Data_${stamp}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    console.error("[/admin/export-excel] error:", err.message);
    res.status(500).send("Could not generate the Excel export. Please try again.");
  }
});

/* ==============================
   LOGIN ROUTES
============================== */
app.get("/login", (req, res) => {
  if (!databaseAvailable) {
    return res.render("login", {
      adminAccount: OFFLINE_ADMIN_USER.account,
      loginError: null,
      resetError: null,
      resetSuccess: "No-XAMPP test mode: MySQL is not running. Use the test/admin passcode to access configuration-only admin tools."
    });
  }

  const sql = "SELECT account FROM accounts LIMIT 1";
  connection.query(sql, (err, results) => {
    if (err) {
      databaseAvailable = false;
      console.error("Database error:", err);
      return res.render("login", {
        adminAccount: OFFLINE_ADMIN_USER.account,
        loginError: null,
        resetError: null,
        resetSuccess: "No-XAMPP test mode: MySQL is not running. Use the test/admin passcode to access configuration-only admin tools."
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

  if (!databaseAvailable) {
    if (password === OFFLINE_ADMIN_PASSWORD) {
      req.session.user = OFFLINE_ADMIN_USER;
      return res.redirect("/admin");
    }
    return res.render("login", {
      adminAccount: OFFLINE_ADMIN_USER.account,
      loginError: "Invalid test/admin passcode",
      resetError: null,
      resetSuccess: "No-XAMPP test mode: MySQL is not running. Use the configured test/admin passcode."
    });
  }

  const getAccountSql = "SELECT * FROM accounts LIMIT 1";
  connection.query(getAccountSql, async (err, results) => {
    if (err) {
      databaseAvailable = false;
      console.error("Database error:", err);
      if (password === OFFLINE_ADMIN_PASSWORD) {
        req.session.user = OFFLINE_ADMIN_USER;
        return res.redirect("/admin");
      }
      return res.render("login", {
        adminAccount: OFFLINE_ADMIN_USER.account,
        loginError: "Database unavailable. Invalid test/admin passcode.",
        resetError: null,
        resetSuccess: null
      });
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
    const runtimeConfig = readRuntimeConfig();

    if (req.session.user.isOffline || !(await canUseDatabase())) {
      return renderOfflineAdmin(req, res);
    }

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
    const [mediaImagesRaw] = await db.query(
      `SELECT * FROM dashboard_media
       WHERE account_id = ? AND media_type = 'image'
       ORDER BY sort_order`,
      [accountId]
    );
    const mediaImages = mergeCaptionsIntoItems(mediaImagesRaw || [], accountId);

    const [mediaVideosRaw] = await db.query(
      `SELECT * FROM dashboard_media
       WHERE account_id = ? AND media_type = 'video'
       ORDER BY sort_order`,
      [accountId]
    );
    const mediaVideos = mergeCaptionsIntoItems(mediaVideosRaw || [], accountId);

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
      runtimeConfig: runtimeConfig,
      automationConfig: runtimeConfig.automation,
      interactiveConfig: runtimeConfig.interactiveMode,
      dashboardSettingsProfiles: runtimeConfig.dashboardSettingsProfiles || [],
      timerProfiles: runtimeConfig.timerProfiles || [],
      defaultTimersSeconds: runtimeConfig.defaultTimersSeconds || {},
      healthSnapshot: latestHealthSnapshot,
      buildingsLoadError: false
    });

  } catch (error) {
    console.error('Error loading admin page:', error);
    const runtimeConfig = readRuntimeConfig();
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
      runtimeConfig: runtimeConfig,
      automationConfig: runtimeConfig.automation,
      interactiveConfig: runtimeConfig.interactiveMode,
      dashboardSettingsProfiles: runtimeConfig.dashboardSettingsProfiles || [],
      timerProfiles: runtimeConfig.timerProfiles || [],
      defaultTimersSeconds: runtimeConfig.defaultTimersSeconds || {},
      healthSnapshot: latestHealthSnapshot,
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

app.post("/admin/media/:id/save-overlay", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  const accountId = req.session.user.id;
  const mediaId = parseInt(req.params.id, 10);

  try {
    const captionText     = req.body.caption_text ? String(req.body.caption_text).trim() : null;
    const captionX        = parseFloat(req.body.caption_x);
    const captionY        = parseFloat(req.body.caption_y);
    const captionFontSize = parseInt(req.body.caption_font_size, 10);

    const captions = readCaptions();
    const key = accountId + "_" + mediaId;

    if (captionText) {
      captions[key] = {
        caption_text:      captionText,
        caption_x:         isFinite(captionX)        ? captionX        : 50,
        caption_y:         isFinite(captionY)        ? captionY        : 85,
        caption_font_size: isFinite(captionFontSize) ? captionFontSize : 24
      };
    } else {
      delete captions[key];
    }

    writeCaptions(captions);
    res.json({ success: true });
  } catch (e) {
    console.error("Error saving overlay:", e);
    res.status(500).json({ error: "Server error" });
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

    const items = mergeCaptionsIntoItems(rows || [], accountId);

    res.json({ type, items });
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

    // Detect year blocks from the building-electric tab's OWN "CYxxxx" labels in
    // column B, rather than reusing the electricity-total year list (yearsArray):
    // the building tab can cover more years than the totals tab (e.g. it has 2026
    // while the totals do not). For each block we locate the "January" row
    // explicitly, so an extra blank row inside a block (the file is not always
    // uniformly 15 rows apart) cannot push the month data out of alignment.
    const elecYearBlocks = [];
    for (let r = 1; r <= 300; r++) {
      const cell = sheet2[`B${r}`];
      if (!cell || cell.v === undefined || cell.v === null) continue;
      const m = String(cell.v).match(/CY\s*(\d{4})/i);
      if (!m) continue;
      const blockYear = parseInt(m[1], 10);
      if (!(blockYear >= 2000 && blockYear <= 2100)) continue;
      let janRow = null;
      for (let rr = r + 1; rr <= r + 6; rr++) {
        const c = sheet2[`B${rr}`];
        if (c && String(c.v).trim().toLowerCase() === "january") { janRow = rr; break; }
      }
      if (janRow) elecYearBlocks.push({ year: blockYear, startRow: janRow });
    }
    // Fallback to the legacy fixed layout (rows 5, 20, 35 ...) for older files
    // that do not carry "CYxxxx" labels in this tab.
    if (elecYearBlocks.length === 0) {
      for (let yearIndex = 0; yearIndex < yearsArray.length; yearIndex++) {
        elecYearBlocks.push({ year: yearsArray[yearIndex], startRow: 5 + yearIndex * 15 });
      }
    }
    console.log(`Tab 2: Detected ${elecYearBlocks.length} electric year blocks:`,
      elecYearBlocks.map(b => `${b.year}@row${b.startRow}`).join(", "));

    for (let colIndex = 2; colIndex <= 23; colIndex++) {
      const col = XLSX.utils.encode_col(colIndex);
      const buildingNameRaw = sheet2[`${col}4`]?.v;
      const buildingName = BuildingNameStandardized(buildingNameRaw);

      if (!buildingName) continue;
      buildingNameSet.add(buildingName);

      if (!buildingElecYears.has(buildingName)) {
        buildingElecYears.set(buildingName, new Set());
      }

      for (const block of elecYearBlocks) {
        const year = block.year;
        const startRow = block.startRow;
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

    // Detect years from the Water tab itself (col B, rows 3, 15, 27, ...).
    // Do NOT reuse the electricity year list (yearsArray): water can cover
    // different years than electricity (e.g. water has 2026 but electricity does not).
    const waterYearsArray = [];
    {
      let waterRow = 3;
      while (waterYearsArray.length < 20) {
        const cell = sheet3[`B${waterRow}`];
        if (!cell || cell.v === undefined || cell.v === null || String(cell.v).trim() === "") break;
        const y = Number(cell.v);
        if (Number.isFinite(y) && y >= 2000 && y <= 2100) {
          waterYearsArray.push(y);
          waterRow += 12;
        } else {
          console.warn(`Tab 3 cell B${waterRow} contains "${cell.v}" - not a valid year`);
          break;
        }
      }
    }
    console.log(`Tab 3: Detected ${waterYearsArray.length} water years:`, waterYearsArray);

    for (let yearIndex = 0; yearIndex < waterYearsArray.length; yearIndex++) {
      const year = waterYearsArray[yearIndex];
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

    console.log(`Tab 3: Inserted ${waterYearsArray.length * 12} total water records`);

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

    // Signal open dashboard screens to reload with the new data.
    bumpDataVersion();

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

    // Signal open dashboard screens to reload now that data was cleared.
    bumpDataVersion();

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
app.listen(port, "127.0.0.1", () => {
  console.log(`Server running at http://localhost:${port}/`);
  syncHealthMonitor();
  syncHibernateMonitor();
  syncInteractiveRevertMonitor();
});

