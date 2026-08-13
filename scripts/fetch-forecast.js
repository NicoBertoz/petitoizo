// Prévisions Open-Meteo pour les spots "vitrine" de chaque région, en format compact
// découpé par cellule géographique (1° x 1°) : le navigateur ne charge que sa région.
//
// Pourquoi un sous-ensemble : l'API gratuite d'Open-Meteo est limitée (~10 000 appels/jour,
// pondérés par nombre de lieux x variables x jours). Rafraîchir les 1 286 spots toutes les
// heures dépasserait le quota. On pré-calcule donc les meilleurs spots de chaque région
// (affichage instantané), et le navigateur complète en direct pour les spots réellement
// affichés autour de l'utilisateur - ce qui est toujours plus frais qu'un snapshot.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FC = join(ROOT, "public/data/forecasts");
const LATEST = join(FC, "latest");
const ARCHIVE = join(FC, "archive");
mkdirSync(LATEST, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });

const PER_CELL = 4;          // spots pré-calculés par cellule de 1° (quota Open-Meteo)
const ARCHIVE_EVERY_H = 6;   // archive une fois toutes les 6 h
const ARCHIVE_KEEP_DAYS = 7;
const ARCHIVE_TOP = 60;      // archives limitées à un jeu de référence (poids du dépôt)

// Variables horaires demandées : les classiques + celles qui parlent aux pilotes
// (plafond de la couche convective, iso 0 °C, vent à 700 hPa ~ 3 000 m).
const API_VARS = [
  "temperature_2m", "precipitation", "precipitation_probability", "cloudcover",
  "cloudcover_low", "windspeed_10m", "winddirection_10m", "windgusts_10m",
  "windspeed_850hPa", "winddirection_850hPa", "windspeed_700hPa",
  "cape", "boundary_layer_height", "freezing_level_height", "is_day",
];
// clés compactes stockées dans le JSON, dans cet ordre
export const VARS = ["t", "p", "pp", "cc", "ccl", "ws", "wd", "wg", "w8", "w8d", "w7", "cape", "blh", "fl", "day"];

export const cellOf = (lat, lon) => `${Math.floor(lat)}_${Math.floor(lon)}`;

const enc = (v, key) => {
  if (v == null) return null;
  if (key === "p") return Math.round(v * 10); // précipitations en dixièmes de mm
  return Math.round(v);
};

async function fetchChunk(chunk) {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${chunk.map((s) => s.lat.toFixed(4)).join(",")}` +
    `&longitude=${chunk.map((s) => s.lon.toFixed(4)).join(",")}` +
    // downscaling : on donne l'altitude réelle du décollage au lieu de celle du modèle
    `&elevation=${chunk.map((s) => (s.altitude != null && s.altitude > 0 ? Math.round(s.altitude) : "nan")).join(",")}` +
    `&hourly=${API_VARS.join(",")}&forecast_days=5&timezone=Europe%2FParis&windspeed_unit=kmh&models=meteofrance_seamless`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 15000 * attempt)); continue; }
    throw new Error(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("Open-Meteo : quota dépassé après 3 tentatives");
}

// ---------- sélection du sous-ensemble ----------
const { spots } = JSON.parse(readFileSync(join(ROOT, "public/data/spots.json"), "utf8"));
const byCell = new Map();
for (const s of spots) {
  const k = cellOf(s.lat, s.lon);
  if (!byCell.has(k)) byCell.set(k, []);
  byCell.get(k).push(s);
}
const selected = [];
for (const [, list] of byCell) {
  list.sort((a, b) => (b.famous === true) - (a.famous === true) || b.quality - a.quality);
  selected.push(...list.slice(0, PER_CELL));
}
console.log(`${selected.length} spots pré-calculés sur ${spots.length} (${byCell.size} régions, ${PER_CELL}/région)`);

// ---------- récupération ----------
const results = {};
let timeAxis = null;
const CHUNK = 40;
for (let i = 0; i < selected.length; i += CHUNK) {
  const chunk = selected.slice(i, i + CHUNK);
  const data = await fetchChunk(chunk);
  const arr = Array.isArray(data) ? data : [data];
  arr.forEach((d, j) => {
    const spot = chunk[j];
    const h = d.hourly;
    // AROME/ARPEGE s'arrêtent avant la fin de la fenêtre demandée : on tronque à la
    // dernière heure réellement prévue plutôt que d'afficher des trous.
    const ws = h.windspeed_10m;
    let valid = ws.length;
    while (valid > 0 && ws[valid - 1] == null) valid--;
    if (!timeAxis || valid < timeAxis.length) timeAxis = h.time.slice(0, valid);
    results[spot.slug] = {
      c: cellOf(spot.lat, spot.lon),
      e: Math.round(d.elevation ?? spot.altitude ?? 0),
      v: API_VARS.map((name, k) => h[name].slice(0, valid).map((x) => enc(x, VARS[k]))),
    };
  });
  console.log(`  lot ${i / CHUNK + 1}/${Math.ceil(selected.length / CHUNK)} (${arr.length} spots)`);
  await new Promise((r) => setTimeout(r, 500));
}

// ---------- écriture par région ----------
const now = new Date();
const meta = {
  fetched_at: now.toISOString(),
  model: "Météo-France AROME 1,3 km puis ARPEGE (Open-Meteo), downscalé à l'altitude du décollage",
  time_start: timeAxis[0],
  hours: timeAxis.length,
  vars: VARS,
};

const H = timeAxis.length;
const cells = {};
for (const [slug, r] of Object.entries(results)) {
  (cells[r.c] ||= {})[slug] = { e: r.e, v: r.v.map((a) => a.slice(0, H)) };
}
for (const [cell, data] of Object.entries(cells)) {
  writeFileSync(join(LATEST, `${cell}.json`), JSON.stringify({ ...meta, cell, spots: data }));
}
writeFileSync(join(FC, "index.json"), JSON.stringify({
  ...meta,
  cells: Object.keys(cells).sort(),
  spot_count: Object.keys(results).length,
  archives: listArchives(),
}, null, 1));

// ---------- archive périodique ----------
function listArchives() {
  if (!existsSync(ARCHIVE)) return [];
  return readdirSync(ARCHIVE).filter((f) => f.endsWith(".json")).sort().reverse()
    .map((f) => ({ file: f, fetched_at: f.replace(".json", "").replace(/-(\d\d)-(\d\d)$/, "T$1:$2") }));
}

if (now.getUTCHours() % ARCHIVE_EVERY_H === 0) {
  const stamp = now.toISOString().slice(0, 13).replace(/[:T]/g, "-") + "-00";
  // On n'archive qu'un jeu de référence : sites majeurs + les mieux documentés.
  // Archiver les 400 spots toutes les 6 h ferait grossir le dépôt de plusieurs Go par an.
  const refSlugs = new Set(
    selected.filter((s) => s.famous)
      .concat([...selected].sort((a, b) => b.quality - a.quality).slice(0, ARCHIVE_TOP))
      .map((s) => s.slug));
  const refData = Object.fromEntries(Object.entries(results).filter(([slug]) => refSlugs.has(slug)));
  writeFileSync(join(ARCHIVE, `${stamp}.json`), JSON.stringify({ ...meta, spot_count: Object.keys(refData).length, spots: refData }));
  // purge des archives trop anciennes
  const cutoff = Date.now() - ARCHIVE_KEEP_DAYS * 86400000;
  for (const f of readdirSync(ARCHIVE)) {
    const iso = f.replace(".json", "").replace(/^(\d{4})-(\d\d)-(\d\d)-(\d\d).*$/, "$1-$2-$3T$4:00:00Z");
    if (Date.parse(iso) < cutoff) unlinkSync(join(ARCHIVE, f));
  }
  // réécrit l'index avec la nouvelle archive
  const idx = JSON.parse(readFileSync(join(FC, "index.json"), "utf8"));
  idx.archives = listArchives();
  writeFileSync(join(FC, "index.json"), JSON.stringify(idx, null, 1));
  console.log(`archive écrite : ${stamp}.json (${listArchives().length} conservées)`);
}

const totalKo = Object.keys(cells).reduce((a, c) =>
  a + Buffer.byteLength(JSON.stringify({ ...meta, spots: cells[c] })), 0) / 1024;
console.log(`OK - ${Object.keys(results).length} spots, ${Object.keys(cells).length} fichiers région, ${Math.round(totalKo)} Ko au total`);
