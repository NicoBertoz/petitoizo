// Balises de vent en temps réel du réseau OpenWindMap / Pioupiou (données ouvertes,
// maintenues par des bénévoles). On ne stocke que la liste des balises et leur position :
// les mesures sont lues en direct par le navigateur, sinon elles seraient périmées.
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(ROOT, "public/data"), { recursive: true });

const res = await fetch("http://api.pioupiou.fr/v1/live-with-meta/all");
if (!res.ok) throw new Error(`OpenWindMap HTTP ${res.status}`);
const json = await res.json();
const all = json.data || json;

const beacons = all
  .filter((s) => s.location?.latitude && s.location?.longitude && s.status?.state === "on")
  // France métropolitaine + marge
  .filter((s) => s.location.latitude > 41 && s.location.latitude < 52 &&
    s.location.longitude > -6 && s.location.longitude < 10)
  .map((s) => ({
    id: s.id,
    name: (s.meta?.name || `Balise ${s.id}`).replace(/[—–]/g, "-").trim(),
    lat: Math.round(s.location.latitude * 10000) / 10000,
    lon: Math.round(s.location.longitude * 10000) / 10000,
    description: (s.meta?.description || "").replace(/[—–]/g, "-").trim().slice(0, 200),
  }))
  .sort((a, b) => a.id - b.id);

writeFileSync(join(ROOT, "public/data/beacons.json"), JSON.stringify({
  generated_at: new Date().toISOString(),
  source: "OpenWindMap / Pioupiou (api.pioupiou.fr), réseau de balises communautaire",
  licence: "(c) contributors of the OpenWindMap wind network",
  count: beacons.length,
  beacons,
}));
console.log(`OK - ${beacons.length} balises OpenWindMap actives en France`);
