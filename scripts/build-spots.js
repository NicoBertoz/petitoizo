// Construit public/data/spots.json à partir des exports ParaglidingEarth (données
// communautaires, largement issues des sites FFVL) + enrichissement manuel data/curated.json.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

// Décodage double (les fichiers contiennent de l'UTF-8 encodé en entités numériques par octet)
function fixUtf8(s) {
  try {
    const bytes = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp <= 0xff) bytes.push(cp);
      else {
        // déjà correct : ré-encoder proprement
        const enc = new TextEncoder().encode(ch);
        bytes.push(...enc);
      }
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return decoded;
  } catch {
    return s;
  }
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? fixUtf8(decode(m[1])) : "";
};
const num = (xml, name) => {
  const v = tag(xml, name);
  return v === "" ? null : Number(v);
};

function parseFile(path) {
  const xml = readFileSync(path, "utf8");
  const sites = [];
  // Les entrées sont soit <takeoff>...</takeoff> seuls, soit <site><takeoff>..</takeoff><landing>..</landing></site>
  const blocks = xml.match(/<site>[\s\S]*?<\/site>|<takeoff>[\s\S]*?<\/takeoff>/g) || [];
  for (const block of blocks) {
    if (block.startsWith("<takeoff>") === false && !block.includes("<takeoff>")) continue;
    const toMatch = block.match(/<takeoff>[\s\S]*?<\/takeoff>/);
    if (!toMatch) continue;
    const to = toMatch[0];
    const landingBlock = block.match(/<landing>[\s\S]*?<\/landing>/);
    const orient = {};
    for (const d of ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]) {
      const m = to.match(new RegExp(`<${d}>(\\d)</${d}>`));
      orient[d] = m ? Number(m[1]) : 0;
    }
    const site = {
      pge_id: num(to, "pge_site_id"),
      name: tag(to, "name"),
      lat: num(to, "lat"),
      lon: num(to, "lng"),
      altitude: num(to, "takeoff_altitude"),
      orientations: orient,
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
      landing: null,
    };
    if (landingBlock) {
      const lb = landingBlock[0];
      site.landing = {
        name: tag(lb, "landing_name") || "Atterrissage officiel",
        lat: num(lb, "landing_lat"),
        lon: num(lb, "landing_lng"),
        altitude: num(lb, "landing_altitude"),
        description: tag(lb, "landing_description"),
      };
    }
    if (site.lat && site.lon && site.name) sites.push(site);
  }
  return sites;
}

const slugify = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const all = [
  ...parseFile(join(ROOT, "data/raw/gre.xml")),
  ...parseFile(join(ROOT, "data/raw/cha.xml")),
];

// Dédoublonnage par pge_id (les rayons Grenoble/Chambéry se recouvrent)
const byId = new Map();
for (const s of all) {
  const key = s.pge_id ?? `${s.lat},${s.lon}`;
  if (!byId.has(key)) byId.set(key, s);
}

let spots = [...byId.values()].filter((s) => s.paragliding || s.hanggliding);

// Spots ajoutés manuellement (absents de ParaglidingEarth)
const extra = JSON.parse(readFileSync(join(ROOT, "data/extra-spots.json"), "utf8"));
spots.push(...extra);

// Enrichissement manuel
const curated = JSON.parse(readFileSync(join(ROOT, "data/curated.json"), "utf8"));
const bySlug = new Map(curated.map((c) => [c.match, c]));
for (const s of spots) {
  s.slug = slugify(s.name);
  const c =
    bySlug.get(String(s.pge_id)) ||
    curated.find((c) => s.slug.includes(c.match) || s.name.toLowerCase().includes(c.match));
  if (c) {
    const { match, ...rest } = c;
    Object.assign(s, rest);
  }
  // valeurs par défaut
  s.transport = s.transport || ["voiture"];
  if (!s.level_min) {
    const txt = `${s.takeoff_description} ${s.comments}`.toLowerCase();
    if (/école|ecole|school|beginner|débutant|debutant|easy|facile|large take ?off/.test(txt))
      s.level_min = "débutant";
    else if (/unauthorized|no landing|expert|dangerous|strong|interdit/.test(txt))
      s.level_min = "confirmé";
    else s.level_min = "intermédiaire";
  }
}

// tri : sites vedettes d'abord, puis alphabétique
spots.sort((a, b) => (b.famous === true) - (a.famous === true) || a.name.localeCompare(b.name, "fr"));

const out = {
  generated_at: new Date().toISOString(),
  source:
    "ParaglidingEarth (données communautaires FFVL/CDVL) + enrichissement manuel Petitoizo",
  count: spots.length,
  spots,
};
writeFileSync(join(ROOT, "public/data/spots.json"), JSON.stringify(out, null, 1));
console.log(`OK — ${spots.length} spots écrits dans public/data/spots.json`);
for (const s of spots.slice(0, 100)) console.log(`${s.pge_id}\t${s.name}\t${s.level_min}\t${s.famous ? "★" : ""}`);
