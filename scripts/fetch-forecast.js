// Récupère les prévisions horaires 8 jours pour tous les spots via Open-Meteo (gratuit, sans clé),
// et les archive en snapshots horodatés (permet de rejouer d'anciennes prévisions).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FC_DIR = join(ROOT, "public/data/forecasts");
mkdirSync(FC_DIR, { recursive: true });

const HOURLY = [
  "temperature_2m",
  "precipitation",
  "precipitation_probability",
  "cloudcover",
  "windspeed_10m",
  "winddirection_10m",
  "windgusts_10m",
  "windspeed_850hPa",
  "winddirection_850hPa",
  "cape",
  "is_day",
].join(",");

const { spots } = JSON.parse(readFileSync(join(ROOT, "public/data/spots.json"), "utf8"));

const chunks = [];
for (let i = 0; i < spots.length; i += 40) chunks.push(spots.slice(i, i + 40));

const bySpot = {};
for (const [ci, chunk] of chunks.entries()) {
  const lats = chunk.map((s) => s.lat.toFixed(4)).join(",");
  const lons = chunk.map((s) => s.lon.toFixed(4)).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
    `&hourly=${HOURLY}&forecast_days=8&timezone=Europe%2FParis&windspeed_unit=kmh`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [data];
  arr.forEach((d, i) => {
    const spot = chunk[i];
    bySpot[spot.slug] = { hourly: d.hourly };
  });
  console.log(`chunk ${ci + 1}/${chunks.length} ok (${arr.length} spots)`);
  await new Promise((r) => setTimeout(r, 400));
}

const now = new Date();
const stamp = now.toISOString().replace(/[:]/g, "-").slice(0, 16); // 2026-08-13T02-30
const snapshot = {
  fetched_at: now.toISOString(),
  model: "Open-Meteo best_match (AROME/ARPEGE/ICON)",
  timezone: "Europe/Paris",
  spot_count: Object.keys(bySpot).length,
  forecasts: bySpot,
};

const snapPath = join(FC_DIR, `${stamp}.json`);
writeFileSync(snapPath, JSON.stringify(snapshot));
writeFileSync(join(FC_DIR, "latest.json"), JSON.stringify(snapshot));

// index des snapshots
const idxPath = join(FC_DIR, "index.json");
const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, "utf8")) : { snapshots: [] };
if (!idx.snapshots.find((s) => s.file === `${stamp}.json`)) {
  idx.snapshots.push({ file: `${stamp}.json`, fetched_at: now.toISOString() });
}
idx.snapshots.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));
idx.snapshots = idx.snapshots.slice(0, 60); // garde ~60 snapshots
writeFileSync(idxPath, JSON.stringify(idx, null, 1));

console.log(`OK — snapshot ${stamp}.json (${Object.keys(bySpot).length} spots), latest.json mis à jour`);
