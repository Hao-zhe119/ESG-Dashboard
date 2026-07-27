/**
 * Canonical building-name spelling used as the storage key in
 * building_ebills / building_waterusage.
 *
 * Shared so anything that reads the same workbooks the app imports (e.g.
 * scripts/repair-text-formatted-cells.js) keys rows exactly the way the
 * importer did.
 */
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

module.exports = { BuildingNameStandardized };
