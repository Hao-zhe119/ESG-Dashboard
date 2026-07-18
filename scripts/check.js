const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const rootDir = path.join(__dirname, "..");

function fail(message, detail) {
  console.error(`FAIL ${message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

function walkFiles(dir, extension, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, extension, files);
    } else if (entry.isFile() && fullPath.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

const jsFiles = [
  path.join(rootDir, "app.js"),
  path.join(rootDir, "config", "dashboardConfig.js"),
  __filename
];

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    fail(`JavaScript syntax check failed for ${path.relative(rootDir, file)}`, result.stderr || result.stdout);
  } else {
    console.log(`OK ${path.relative(rootDir, file)}`);
  }
}

for (const file of walkFiles(path.join(rootDir, "views"), ".ejs")) {
  try {
    ejs.compile(fs.readFileSync(file, "utf8"), { filename: file });
    console.log(`OK ${path.relative(rootDir, file)}`);
  } catch (error) {
    fail(`EJS compile failed for ${path.relative(rootDir, file)}`, error.stack || error.message);
  }
}

for (const file of walkFiles(path.join(rootDir, "config"), ".json")) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`OK ${path.relative(rootDir, file)}`);
  } catch (error) {
    fail(`JSON parse failed for ${path.relative(rootDir, file)}`, error.message);
  }
}
