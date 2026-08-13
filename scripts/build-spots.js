// Construit public/data/spots.json (France entière) en fusionnant :
//   1. ParaglidingEarth  - base communautaire mondiale (descriptions, accès, atterrissages)
//   2. OpenStreetMap     - sites de vol libre, largement issus de l'import FFVL
//                          (tags free_flying:*, liens federation.ffvl.fr)
// + enrichissement manuel data/curated.json et data/extra-spots.json.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// ---------- utilitaires ----------
const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();

// ParaglidingEarth encode l'UTF-8 en entités numériques octet par octet
function fixUtf8(s) {
  try {
    const bytes = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp <= 0xff) bytes.push(cp);
      else bytes.push(...new TextEncoder().encode(ch));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch { return s; }
}

const haversine = (a, b) => {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const slugify = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// nom normalisé pour comparer deux sources
const normName = (s) =>
  slugify(s).replace(/^(decollage|deco|takeoff|atterrissage|attero|landing)-/, "").replace(/-/g, "");

const emptyOrient = () => Object.fromEntries(DIRS.map((d) => [d, 0]));

// ---------- 1. ParaglidingEarth ----------
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? fixUtf8(decode(m[1])) : "";
};
const num = (xml, name) => {
  const v = tag(xml, name);
  return v === "" || isNaN(Number(v)) ? null : Number(v);
};

function parsePGE() {
  const xml = readFileSync(join(ROOT, "data/raw/pge-fr.xml"), "utf8");
  const blocks = xml.match(/<site>[\s\S]*?<\/site>|<takeoff>[\s\S]*?<\/takeoff>/g) || [];
  const out = [];
  for (const block of blocks) {
    const toMatch = block.match(/<takeoff>[\s\S]*?<\/takeoff>/);
    if (!toMatch) continue;
    const to = toMatch[0];
    const lat = num(to, "lat"), lon = num(to, "lng"), name = tag(to, "name");
    if (!lat || !lon || !name) continue;

    const orientations = emptyOrient();
    for (const d of DIRS) {
      const m = to.match(new RegExp(`<${d}>(\\d)</${d}>`));
      orientations[d] = m ? Number(m[1]) : 0;
    }

    const landingBlock = block.match(/<landing>[\s\S]*?<\/landing>/);
    let landing = null;
    if (landingBlock) {
      const lb = landingBlock[0];
      const llat = num(lb, "landing_lat"), llon = num(lb, "landing_lng");
      if (llat && llon) {
        landing = {
          name: tag(lb, "landing_name") || "Atterrissage officiel",
          lat: llat, lon: llon,
          altitude: num(lb, "landing_altitude"),
          description: tag(lb, "landing_description"),
        };
      }
    }

    out.push({
      sources: ["paraglidingearth"],
      pge_id: num(to, "pge_site_id"),
      name, lat, lon,
      altitude: num(to, "takeoff_altitude"),
      orientations,
      paragliding: num(to, "paragliding") === 1,
      hanggliding: num(to, "hanggliding") === 1,
      thermals: num(to, "thermals") === 1,
      soaring: num(to, "soaring") === 1,
      xc: num(to, "xc") === 1,
      hike: num(to, "hike") === 1,
      takeoff_description: tag(to, "takeoff_description"),
      going_there: tag(to, "going_there"),
      weather_notes: tag(to, "weather"),
      comments: tag(to, "comments"),
      flight_rules: tag(to, "flight_rules"),
      pge_link: tag(to, "pge_link"),
      landing,
    });
  }
  return out;
}

// ---------- 2. OpenStreetMap / FFVL ----------
// "O;NO", "N,NW", "s,sw" -> secteurs. En français : O = Ouest, NO = Nord-Ouest.
const OSM_DIR = {
  N: "N", NE: "NE", NO: "NW", NW: "NW", E: "E", SE: "SE",
  S: "S", SO: "SW", SW: "SW", O: "W", W: "W",
};
function parseOrientationTag(v) {
  const orientations = emptyOrient();
  let found = false;
  for (const part of String(v).toUpperCase().split(/[,;/|+\s]+/)) {
    const d = OSM_DIR[part.trim()];
    if (d) { orientations[d] = 2; found = true; }
  }
  return found ? orientations : null;
}

function parseOSM() {
  const data = JSON.parse(readFileSync(join(ROOT, "data/raw/osm-fr.json"), "utf8"));
  const takeoffs = [], landings = [];
  for (const el of data.elements) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!lat || !lon) continue;
    if (t.status === "inactive" || t.status === "closed") continue;

    const kind = String(t["free_flying:site"] || "").toLowerCase();
    const isLanding = kind.includes("landing") && !kind.includes("takeoff");
    const isTakeoff = kind.includes("takeoff") || kind.includes("takoff") ||
      (!kind && (t["free_flying:paragliding"] === "yes" || t["free_flying:hanggliding"] === "yes"));

    const name = (t.name || t.official_name || "").trim();
    if (isLanding) {
      landings.push({ lat, lon, name: name || "Atterrissage", altitude: t.ele ? Math.round(+t.ele) : null,
        description: t.description || "" });
      continue;
    }
    if (!isTakeoff || !name) continue;

    const orientations = parseOrientationTag(t["free_flying:site_orientation"] || "");
    const ffvlUrl = /federation\.ffvl\.fr/.test(t.website || "") ? t.website : null;
    takeoffs.push({
      sources: ffvlUrl ? ["osm", "ffvl"] : ["osm"],
      osm_id: `${el.type}/${el.id}`,
      name, lat, lon,
      altitude: t.ele ? Math.round(+t.ele) : null,
      orientations: orientations || emptyOrient(),
      orientation_known: !!orientations,
      paragliding: t["free_flying:paragliding"] !== "no",
      hanggliding: t["free_flying:hanggliding"] === "yes",
      thermals: false, soaring: false, xc: false, hike: false,
      takeoff_description: t.description || "",
      going_there: t["addr:town"] ? `Commune : ${t["addr:town"]}${t.postal_code ? " (" + t.postal_code + ")" : ""}` : "",
      weather_notes: "", comments: "",
      flight_rules: t.access && t.access !== "yes" ? `Accès OSM : ${t.access}` : "",
      pge_link: "",
      ffvl_url: ffvlUrl,
      club: t.operator || null,
      club_url: t["operator:website"] || null,
      official: t["free_flying:official"] === "yes",
      landing: null,
    });
  }
  // rattache l'atterrissage OSM le plus proche (< 6 km)
  for (const t of takeoffs) {
    let best = null, bestD = 6000;
    for (const l of landings) {
      const d = haversine(t, l);
      if (d < bestD) { bestD = d; best = l; }
    }
    if (best) t.landing = { ...best, description: best.description || `Atterrissage OSM le plus proche (${Math.round(bestD)} m).` };
  }
  return { takeoffs, landings };
}

// ---------- 3. Fusion ----------
const MATCH_METRES = 700;

function mergeInto(base, extra) {
  base.sources = [...new Set([...base.sources, ...extra.sources])];
  // orientations : union, on garde la meilleure note par secteur
  const baseKnown = DIRS.some((d) => base.orientations[d] > 0);
  const extraKnown = DIRS.some((d) => extra.orientations[d] > 0);
  if (extraKnown && !baseKnown) base.orientations = extra.orientations;
  else if (extraKnown && baseKnown) {
    for (const d of DIRS) base.orientations[d] = Math.max(base.orientations[d], extra.orientations[d]);
  }
  for (const k of ["altitude", "takeoff_description", "going_there", "weather_notes",
    "comments", "flight_rules", "pge_link", "ffvl_url", "club", "club_url", "osm_id", "pge_id"]) {
    if (!base[k] && extra[k]) base[k] = extra[k];
  }
  for (const k of ["paragliding", "hanggliding", "thermals", "soaring", "xc", "hike", "official"]) {
    base[k] = base[k] || extra[k];
  }
  if (!base.landing && extra.landing) base.landing = extra.landing;
  return base;
}

const pgeSpots = parsePGE();
const { takeoffs: osmSpots, landings: osmLandings } = parseOSM();

// index spatial grossier (cellules ~0.01° ≈ 1 km) pour éviter le O(n²)
const cellKey = (s) => `${Math.round(s.lat * 100)}_${Math.round(s.lon * 100)}`;
const grid = new Map();
const addToGrid = (s) => {
  const k = cellKey(s);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(s);
};
const neighbours = (s) => {
  const out = [];
  const la = Math.round(s.lat * 100), lo = Math.round(s.lon * 100);
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const c = grid.get(`${la + i}_${lo + j}`);
    if (c) out.push(...c);
  }
  return out;
};

const merged = [];
let stats = { pge: pgeSpots.length, osm: osmSpots.length, common: 0, pgeOnly: 0, osmOnly: 0 };

for (const s of pgeSpots) { merged.push(s); addToGrid(s); }

for (const o of osmSpots) {
  const candidates = neighbours(o);
  let match = null, bestD = Infinity;
  for (const c of candidates) {
    const d = haversine(o, c);
    const sameName = normName(o.name) && normName(o.name) === normName(c.name);
    // proche géographiquement, ou un peu plus loin mais même nom
    if ((d < MATCH_METRES || (d < 2500 && sameName)) && d < bestD) { bestD = d; match = c; }
  }
  if (match) { mergeInto(match, o); stats.common++; }
  else { merged.push(o); addToGrid(o); stats.osmOnly++; }
}
stats.pgeOnly = stats.pge - stats.common;

// ---------- 4. Filtrage, enrichissement, qualité ----------
let spots = merged.filter((s) => s.paragliding || s.hanggliding);

// spots ajoutés manuellement
const extra = JSON.parse(readFileSync(join(ROOT, "data/extra-spots.json"), "utf8"));
for (const e of extra) {
  const dup = spots.find((s) => haversine(s, e) < MATCH_METRES);
  if (dup) mergeInto(dup, { ...e, sources: ["petitoizo"] });
  else spots.push({ ...e, sources: ["petitoizo"] });
}

const curated = JSON.parse(readFileSync(join(ROOT, "data/curated.json"), "utf8"));
const usedSlugs = new Map();

for (const s of spots) {
  // slug unique et stable
  let slug = slugify(s.name);
  if (usedSlugs.has(slug)) {
    const n = usedSlugs.get(slug) + 1;
    usedSlugs.set(slug, n);
    slug = `${slug}-${n}`;
  } else usedSlugs.set(slug, 1);
  s.slug = slug;

  // enrichissement manuel (par pge_id ou par nom)
  const c = curated.find((c) => String(s.pge_id) === c.match) ||
    curated.find((c) => s.slug.includes(c.match) || s.name.toLowerCase().includes(c.match));
  if (c) { const { match, ...rest } = c; Object.assign(s, rest); }

  s.transport = s.transport || ["voiture"];
  if (!s.level_min) {
    const txt = `${s.takeoff_description} ${s.comments}`.toLowerCase();
    if (/école|ecole|school|beginner|débutant|debutant|easy|facile|large take ?off/.test(txt)) s.level_min = "débutant";
    else if (/unauthorized|no landing|expert|dangerous|strong|interdit/.test(txt)) s.level_min = "confirmé";
    else s.level_min = "intermédiaire";
  }
  s.orientation_known = DIRS.some((d) => s.orientations[d] > 0);
  // indice de complétude, sert à trier et à prévenir l'utilisateur
  s.quality = [
    s.orientation_known, !!s.altitude, !!s.landing, !!s.takeoff_description,
    !!(s.going_there || s.transport_notes), s.sources.length > 1,
  ].filter(Boolean).length;
  delete s.paragliding;
}

// tri : sites vedettes, puis les mieux documentés
spots.sort((a, b) =>
  (b.famous === true) - (a.famous === true) || b.quality - a.quality || a.name.localeCompare(b.name, "fr"));

const withOrientation = spots.filter((s) => s.orientation_known).length;
const withFFVL = spots.filter((s) => s.ffvl_url).length;

// pas de tirets cadratins dans les textes affichés, y compris ceux venant des sources
const stripDashes = (o) => {
  if (typeof o === "string") return o.replace(/[—–]/g, "-");
  if (Array.isArray(o)) return o.map(stripDashes);
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, stripDashes(v)]));
  return o;
};
spots = stripDashes(spots);

const out = {
  generated_at: new Date().toISOString(),
  sources: {
    paraglidingearth: "http://www.paraglidingearth.com (base communautaire mondiale)",
    openstreetmap: "Overpass API, tags free_flying:* (largement issus de l'import FFVL)",
    petitoizo: "enrichissement manuel (data/curated.json, data/extra-spots.json)",
  },
  stats: { ...stats, total: spots.length, withOrientation, withFFVL, osmLandings: osmLandings.length },
  count: spots.length,
  spots,
};
writeFileSync(join(ROOT, "public/data/spots.json"), JSON.stringify(out));

console.log(`ParaglidingEarth : ${stats.pge} décollages`);
console.log(`OpenStreetMap    : ${stats.osm} décollages (+ ${osmLandings.length} atterrissages)`);
console.log(`  communs aux deux sources : ${stats.common}`);
console.log(`  ParaglidingEarth seul    : ${stats.pgeOnly}`);
console.log(`  OpenStreetMap seul       : ${stats.osmOnly}`);
console.log(`TOTAL : ${spots.length} spots | orientation connue : ${withOrientation} (${Math.round(100 * withOrientation / spots.length)} %) | fiche FFVL : ${withFFVL}`);
