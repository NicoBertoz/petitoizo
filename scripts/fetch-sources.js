// Télécharge les sources brutes de spots (France entière) dans data/raw/.
// 1. ParaglidingEarth : base communautaire mondiale, endpoint pays.
// 2. OpenStreetMap (Overpass) : sites de vol libre, largement alimentés par
//    l'import FFVL (tags free_flying:*, liens federation.ffvl.fr).
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data/raw");
mkdirSync(RAW, { recursive: true });

// ---------- ParaglidingEarth ----------
const PGE_URL = "http://www.paraglidingearth.com/api/getCountrySites.php?iso=fr&style=detailled";
console.log("ParaglidingEarth : téléchargement de la France...");
const pge = await fetch(PGE_URL).then((r) => r.text());
const pgeCount = (pge.match(/<takeoff>/g) || []).length;
if (pgeCount < 500) throw new Error(`ParaglidingEarth : seulement ${pgeCount} décollages, réponse suspecte`);
writeFileSync(join(RAW, "pge-fr.xml"), pge);
console.log(`  -> ${pgeCount} décollages, ${(pge.length / 1024 / 1024).toFixed(2)} Mo`);

// ---------- OpenStreetMap / Overpass ----------
const QUERY = `[out:json][timeout:180];
area["ISO3166-1"="FR"][admin_level=2]->.fr;
(
  node["sport"="free_flying"](area.fr);
  way["sport"="free_flying"](area.fr);
);
out center tags;`;

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Overpass exige un User-Agent identifiable et applique des quotas : on réessaie.
const UA = "Petitoizo/1.0 (https://github.com/NicoBertoz/petitoizo)";
let osm = null;
outer: for (let attempt = 1; attempt <= 3 && !osm; attempt++) {
  for (const url of MIRRORS) {
    try {
      console.log(`OpenStreetMap : requête Overpass (${new URL(url).host}, essai ${attempt})...`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: QUERY }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.elements?.length) throw new Error("réponse vide");
      osm = json;
      break outer;
    } catch (e) {
      console.warn(`  échec (${e.message})`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}
if (!osm) throw new Error("Overpass injoignable sur tous les miroirs");
writeFileSync(join(RAW, "osm-fr.json"), JSON.stringify(osm));
console.log(`  -> ${osm.elements.length} éléments`);
