const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "dashboardRuntimeConfig.json");

const DEFAULT_CONFIG = {
  // Bumped every time ESG data is uploaded or cleared. Open dashboards poll
  // this value and reload themselves when it changes, so the charts always
  // reflect the latest upload without a manual refresh.
  dataVersion: 0,
  defaultTimersSeconds: {
    1: 15,
    2: 60,
    3: 60,
    4: 60,
    5: 60,
    6: 60,
    7: 60,
    8: 4,
    9: 30,
    10: 15
  },
  defaultAnimations: {
    1: "rain",
    2: "particles",
    3: "sparks",
    4: "particles",
    5: "particles",
    6: "sun",
    7: "leaves",
    8: "particles",
    9: "particles",
    10: "particles"
  },
  interactiveMode: {
    autoSwitchOnActivity: true,
    autoRevertEnabled: true,
    idleTimeoutMinutes: 15,
    lastActivityAt: null
  },
  automation: {
    applyDefaultTimingEnabled: false,
    autoHibernateEnabled: false,
    autoHibernateDryRun: true,
    autoHibernateSchedule: {
      startTime: "22:00",
      endTime: "07:00",
      activeProfileId: "default",
      days: {
        monday: { enabled: true, startTime: "22:00", endTime: "07:00" },
        tuesday: { enabled: true, startTime: "22:00", endTime: "07:00" },
        wednesday: { enabled: true, startTime: "22:00", endTime: "07:00" },
        thursday: { enabled: true, startTime: "22:00", endTime: "07:00" },
        friday: { enabled: true, startTime: "22:00", endTime: "07:00" },
        saturday: { enabled: false, startTime: "22:00", endTime: "07:00" },
        sunday: { enabled: false, startTime: "22:00", endTime: "07:00" }
      }
    },
    autoHibernateProfiles: [
      {
        id: "default",
        name: "Default Hibernate Schedule",
        startTime: "22:00",
        endTime: "07:00",
        isDefault: true,
        createdAt: null
      }
    ],
    lastHibernateDryRunAt: null,
    lastHibernateRunKey: null,
    healthCheckEnabled: false,
    healthCheckTime: "08:00",
    lastScheduledHealthCheckDate: null
  },
  timerProfiles: [],
  buildingPageGroups: {
    3: ["E1", "E2", "E3", "E4", "E5", "E6"],
    4: ["W1", "W2", "W3", "W4", "W5", "W6"],
    5: ["ECMC", "RPC", "TRCC", "Sports Complex", "The Arch", "Green House"],
    6: ["BLK 43", "RPIC", "XLC", "ALC"]
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(defaults, current) {
  if (Array.isArray(defaults)) return Array.isArray(current) ? current : defaults;
  if (!isPlainObject(defaults)) return current === undefined ? defaults : current;

  const merged = { ...defaults };
  if (!isPlainObject(current)) return merged;

  Object.keys(current).forEach((key) => {
    merged[key] = mergeConfig(defaults[key], current[key]);
  });

  return merged;
}

function readRuntimeConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return mergeConfig(DEFAULT_CONFIG, {});
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw || "{}"));
  } catch (error) {
    console.warn("Failed to read dashboard runtime config, using defaults:", error.message);
    return mergeConfig(DEFAULT_CONFIG, {});
  }
}

function writeRuntimeConfig(nextConfig) {
  const merged = mergeConfig(DEFAULT_CONFIG, nextConfig || {});
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function updateRuntimeConfig(mutator) {
  const current = readRuntimeConfig();
  const draft = JSON.parse(JSON.stringify(current));
  const result = typeof mutator === "function" ? mutator(draft) : draft;
  return writeRuntimeConfig(result || draft);
}

function getDefaultTimerRows() {
  const config = readRuntimeConfig();
  const timers = config.defaultTimersSeconds || {};
  const animations = config.defaultAnimations || {};
  return Object.entries(timers)
    .map(([pageNumber, seconds]) => ({
      page_number: Number(pageNumber),
      duration_seconds: Math.max(0, Number(seconds) || 0),
      background_animation: animations[pageNumber] || "particles"
    }))
    .filter((item) => Number.isFinite(item.page_number))
    .sort((a, b) => a.page_number - b.page_number);
}

module.exports = {
  DEFAULT_CONFIG,
  readRuntimeConfig,
  writeRuntimeConfig,
  updateRuntimeConfig,
  getDefaultTimerRows
};
