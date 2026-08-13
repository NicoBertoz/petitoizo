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
  // Rattache l'atterrissage OSM le plus proche, mais seulement s'il est plausible :
  // à moins de 4 km et plus bas que le décollage. Et on dit que c'est une déduction.
  for (const t of takeoffs) {
    let best = null, bestD = 4000;
    for (const l of landings) {
      const d = haversine(t, l);
      if (d < bestD && (t.altitude == null || l.altitude == null || l.altitude < t.altitude - 50)) {
        bestD = d; best = l;
      }
    }
    if (best) {
      t.landing = {
        ...best,
        guessed: true,
        description: `${best.description ? best.description + " " : ""}(atterrissage OpenStreetMap le plus proche, à ${Math.round(bestD)} m du décollage - déduit automatiquement, à vérifier)`,
      };
    }
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
// Un nom qui dit "atterrissage" est un atterrissage, quelle que soit la base d'origine.
const LANDING_NAME = /\b(atterr?o|atterrissage|atterissage|landing|attero|posé|pose officiel)\b/i;

let spots = merged.filter((s) => s.paragliding || s.hanggliding);

// --- Filtre 1 : entrées nommées explicitement comme des atterrissages
const droppedByName = spots.filter((s) => LANDING_NAME.test(s.name));
spots = spots.filter((s) => !LANDING_NAME.test(s.name));

// --- Filtre 2 : atterrissages déguisés en décollages.
// Signature typique (cas signalé par les pilotes : "Saint-Jean-de-la-Porte") : aucune
// orientation, aucune description, et un atterrissage connu à moins de 400 m et à la même
// altitude. Sans orientation ni dénivelé, on ne peut de toute façon rien en dire.
const landingPoints = [
  ...osmLandings,
  ...pgeSpots.filter((s) => s.landing).map((s) => s.landing),
].filter((l) => l && l.lat && l.lon);

const looksLikeLanding = (s) => {
  // On ne touche qu'aux entrées totalement vides : ni orientation, ni description, ni accès.
  // Elles ne sont de toute façon pas exploitables ; la question est seulement de savoir si
  // on les affiche comme des décollages alors que ce sont des atterrissages.
  const known = DIRS.some((d) => s.orientations[d] > 0);
  if (known || s.takeoff_description || s.going_there) return false;

  // a) un atterrissage déclaré est juste à côté, à la même altitude
  const nearLanding = landingPoints.some((l) => {
    const d = haversine(s, l);
    if (d > 400) return false;
    if (s.altitude == null || l.altitude == null) return true;
    return Math.abs(s.altitude - l.altitude) < 60;
  });
  if (nearLanding) return true;

  // b) le point est en fond de vallée, dominé de plus de 300 m par un décollage voisin
  //    (cas "Saint-Jean-de-la-Porte", signalé par les pilotes : c'est l'attéro du Montlambert)
  if (s.altitude == null) return false;
  return merged.some((o) =>
    o !== s && o.altitude != null && o.altitude - s.altitude > 300 && haversine(s, o) < 5000);
};
const droppedAsLanding = spots.filter(looksLikeLanding);
spots = spots.filter((s) => !looksLikeLanding(s));
stats.droppedLandings = droppedByName.length + droppedAsLanding.length;

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

  // Pas d'inférence de niveau : personne ne peut déduire d'une description en anglais
  // qu'un site est "école". Le niveau n'est affiché que s'il vient d'une source.
  s.orientation_known = DIRS.some((d) => s.orientations[d] > 0);

  // Indice de complétude (0-6) : sert à trier ET à afficher honnêtement ce qu'on ignore.
  s.quality = [
    s.orientation_known, !!s.altitude, !!s.landing, !!s.takeoff_description,
    !!s.going_there, s.sources.length > 1,
  ].filter(Boolean).length;

  // Niveau de confiance affiché à l'utilisateur.
  // "scorable" décide si on ose calculer un score : sans orientation de décollage,
  // impossible de savoir si le vent est de face ou de cul, donc pas de score.
  s.scorable = s.orientation_known;
  s.confidence = !s.orientation_known ? "insuffisante"
    : s.sources.length > 1 && s.quality >= 5 ? "bonne"
    : s.quality >= 4 ? "moyenne" : "limitée";
  s.missing = [
    !s.orientation_known && "orientation du décollage",
    !s.altitude && "altitude",
    !s.landing && "atterrissage",
    !s.takeoff_description && "description du décollage",
    !s.going_there && "accès",
  ].filter(Boolean);
  delete s.paragliding;
}

// tri : sites vedettes, puis les mieux documentés
spots.sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name, "fr"));

const withOrientation = spots.filter((s) => s.orientation_known).length;
const withFFVL = spots.filter((s) => s.ffvl_url).length;
const byConfidence = spots.reduce((a, s) => ({ ...a, [s.confidence]: (a[s.confidence] || 0) + 1 }), {});

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
  stats: { ...stats, total: spots.length, withOrientation, withFFVL, osmLandings: osmLandings.length, byConfidence },
  count: spots.length,
  spots,
};
writeFileSync(join(ROOT, "public/data/spots.json"), JSON.stringify(out));

console.log(`ParaglidingEarth : ${stats.pge} décollages`);
console.log(`OpenStreetMap    : ${stats.osm} décollages (+ ${osmLandings.length} atterrissages)`);
console.log(`  communs aux deux sources : ${stats.common}`);
console.log(`  ParaglidingEarth seul    : ${stats.pgeOnly}`);
console.log(`  OpenStreetMap seul       : ${stats.osmOnly}`);
console.log(`  atterrissages écartés       : ${stats.droppedLandings}`);
console.log(`TOTAL : ${spots.length} spots | orientation connue : ${withOrientation} (${Math.round(100 * withOrientation / spots.length)} %) | fiche FFVL : ${withFFVL}`);
console.log(`confiance :`, byConfidence);
