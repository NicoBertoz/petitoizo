import {
  SPORTS, LEVELS, scoreSpotHour, scoreSpotDay, dirFromDegrees, DIR_FR, fromDir, orientationLabel,
} from "./scoring.js?v=5";

// ---------- état ----------
const state = {
  sport: localStorage.getItem("pz_sport") || "parapente",
  level: localStorage.getItem("pz_level") || "intermédiaire",
  day: 0,
  hour: "auto",              // "auto" = meilleur créneau de la journée
  center: null,              // {lat, lon, label}
  source: "live",            // "live" | nom de fichier d'archive
  spots: [],
  fc: new Map(),             // slug -> {e, v:[[...]]}  (format compact, ordre VARS)
  meta: null,                // {time_start, hours, fetched_at, model}
  loadedCells: new Set(),
  liveDone: new Set(),
  index: null,
  beacons: [],              // balises OpenWindMap (position seulement)
};

const DEFAULT_CENTER = { lat: 45.35, lon: 5.85, label: "Alpes du Nord" };
const HOURS_SHOWN = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const RADIUS_KM = 120;       // rayon de recherche autour du point choisi
const MAX_NEARBY = 90;       // nombre max de spots interrogés en direct
const VARS = ["t", "p", "pp", "cc", "ccl", "ws", "wd", "wg", "w8", "w8d", "w7", "cape", "blh", "fl", "day"];
const API_VARS = [
  "temperature_2m", "precipitation", "precipitation_probability", "cloudcover",
  "cloudcover_low", "windspeed_10m", "winddirection_10m", "windgusts_10m",
  "windspeed_850hPa", "winddirection_850hPa", "windspeed_700hPa",
  "cape", "boundary_layer_height", "freezing_level_height", "is_day",
];
const V = Object.fromEntries(VARS.map((k, i) => [k, i]));

const $ = (sel) => document.querySelector(sel);
const cellOf = (lat, lon) => `${Math.floor(lat)}_${Math.floor(lon)}`;

const haversine = (a, b) => {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- météo ----------
function wxAt(spot, dayIdx, hour) {
  const rec = state.fc.get(spot.slug);
  if (!rec || !state.meta) return null;
  const i = dayIdx * 24 + hour;
  if (i >= state.meta.hours) return null;
  const g = (k) => rec.v[V[k]]?.[i];
  const d = new Date(new Date(state.meta.time_start).getTime() + i * 3600000);
  return {
    windSpeed: g("ws"), windDir: g("wd"), windGusts: g("wg"),
    windMeta: g("w8"), windMetaDir: g("w8d"), wind700: g("w7"),
    precip: (g("p") ?? 0) / 10, precipProb: g("pp"),
    cloudcover: g("cc"), cloudLow: g("ccl"), cape: g("cape"),
    blh: g("blh"), freezing: g("fl"), temp: g("t"),
    isDay: g("day") ?? 1, hour, month: d.getMonth() + 1,
    elevation: rec.e,
  };
}

function scoreFor(spot, dayIdx, hour) {
  // Sans orientation de décollage connue, on ne peut pas savoir si le vent est de face
  // ou de cul : on n'affiche donc pas de score plutôt que d'en inventer un.
  if (!spot.scorable) return null;
  const opts = { sport: state.sport, level: state.level };
  if (hour === "auto") {
    const hours = HOURS_SHOWN.map((hh) => wxAt(spot, dayIdx, hh)).filter(Boolean);
    if (!hours.length) return null;
    return scoreSpotDay(spot, hours, opts);
  }
  const wx = wxAt(spot, dayIdx, hour);
  return wx ? { ...scoreSpotHour(spot, wx, opts), bestHour: hour } : null;
}

function forecastDates() {
  if (!state.meta) return [];
  const base = new Date(state.meta.time_start);
  return Array.from({ length: Math.floor(state.meta.hours / 24) }, (_, i) => {
    const d = new Date(base); d.setDate(d.getDate() + i); d.setHours(12, 0, 0, 0); return d;
  });
}

// spots proches du centre, triés par distance
function nearbySpots() {
  const center = state.center || DEFAULT_CENTER;
  return state.spots
    .map((spot) => ({ spot, dist: haversine(center, spot) }))
    .filter((x) => x.dist <= RADIUS_KM)
    .sort((a, b) => a.dist - b.dist)
    // on se limite aux plus proches : ce sont ceux dont on calcule réellement la météo
    .slice(0, MAX_NEARBY);
}

// 1. affichage immédiat depuis les fichiers région pré-calculés
async function loadCells(list) {
  const cells = [...new Set(list.map(({ spot }) => cellOf(spot.lat, spot.lon)))]
    .filter((c) => !state.loadedCells.has(c) && state.index?.cells?.includes(c));
  await Promise.all(cells.map(async (c) => {
    state.loadedCells.add(c);
    try {
      const d = await (await fetch(`data/forecasts/latest/${c}.json`)).json();
      state.meta ||= { time_start: d.time_start, hours: d.hours, fetched_at: d.fetched_at, model: d.model };
      for (const [slug, rec] of Object.entries(d.spots)) {
        if (!state.liveDone.has(slug)) state.fc.set(slug, rec);
      }
    } catch { /* région absente : le direct prendra le relais */ }
  }));
}

// 2. prévisions en direct pour les spots réellement affichés
async function loadLive(list) {
  const todo = list.map(({ spot }) => spot).filter((s) => !state.liveDone.has(s.slug)).slice(0, MAX_NEARBY);
  if (!todo.length) return false;
  const CHUNK = 30;
  let changed = false;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${chunk.map((s) => s.lat.toFixed(4)).join(",")}` +
      `&longitude=${chunk.map((s) => s.lon.toFixed(4)).join(",")}` +
      `&elevation=${chunk.map((s) => (s.altitude > 0 ? Math.round(s.altitude) : "nan")).join(",")}` +
      `&hourly=${API_VARS.join(",")}&forecast_days=5&timezone=auto&windspeed_unit=kmh&models=meteofrance_seamless`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      (Array.isArray(data) ? data : [data]).forEach((d, j) => {
        const spot = chunk[j], h = d.hourly;
        // on tronque à la dernière heure réellement prévue par AROME/ARPEGE
        let valid = h.windspeed_10m.length;
        while (valid > 0 && h.windspeed_10m[valid - 1] == null) valid--;
        state.meta = {
          time_start: h.time[0],
          hours: Math.min(valid, state.meta?.hours ?? valid),
          fetched_at: new Date().toISOString(),
          model: "Météo-France AROME 1,3 km puis ARPEGE, en direct, downscalé à l'altitude du décollage",
        };
        state.fc.set(spot.slug, {
          e: Math.round(d.elevation ?? spot.altitude ?? 0),
          v: API_VARS.map((name, k) =>
            h[name].slice(0, valid).map((x) => (x == null ? null : VARS[k] === "p" ? Math.round(x * 10) : Math.round(x)))),
        });
        state.liveDone.add(spot.slug);
        changed = true;
      });
    } catch (e) { console.warn("Open-Meteo indisponible", e); }
  }
  return changed;
}

async function ensureForecasts() {
  if (state.source !== "live") return;      // archive : données déjà chargées
  const list = nearbySpots();
  await loadCells(list);
  renderAll();
  if (await loadLive(list)) renderAll();
}

// ---------- SVG rose des vents ----------
function windRoseSVG(orientations, windDir, size = 64, color = null) {
  const c = size / 2, rOut = c - 2, rIn = size * 0.14;
  const sectors = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  let paths = "";
  sectors.forEach((s, i) => {
    const rating = orientations?.[s] ?? 0;
    const a0 = (i * 45 - 112.5) * (Math.PI / 180), a1 = (i * 45 - 67.5) * (Math.PI / 180);
    const r = rIn + (rOut - rIn) * (rating === 2 ? 1 : rating === 1 ? 0.62 : 0.22);
    const fill = rating === 2 ? "#3b9dfb" : rating === 1 ? "#9cc6fb" : "#dde4ec";
    const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0);
    const x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
    paths += `<path d="M${c},${c} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${fill}"/>`;
  });
  let arrow = "";
  if (windDir != null) {
    const ang = ((windDir + 180) % 360 - 90) * (Math.PI / 180);
    const x = c + (rOut - 4) * Math.cos(ang), y = c + (rOut - 4) * Math.sin(ang);
    const xt = c - (rOut - 10) * Math.cos(ang), yt = c - (rOut - 10) * Math.sin(ang);
    arrow = `<line x1="${xt.toFixed(1)}" y1="${yt.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
      stroke="${color || "#1f2b3a"}" stroke-width="3" stroke-linecap="round" marker-end="url(#ah${size})"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><marker id="ah${size}" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="${color || "#1f2b3a"}"/></marker></defs>
    ${paths}
    <text x="${c}" y="9" text-anchor="middle" font-size="8" fill="#6b7a8d">N</text>
    ${arrow}
  </svg>`;
}

// ---------- balises OpenWindMap (mesures réelles) ----------
// Le modèle prévoit, la balise mesure. Sur un spot, la balise voisine est la seule
// donnée qui dit ce qu'il se passe vraiment maintenant.
function nearestBeacons(spot, maxKm = 20, limit = 3) {
  return state.beacons
    .map((b) => ({ b, dist: haversine(spot, b) }))
    .filter((x) => x.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

async function renderBeacons(spot, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const near = nearestBeacons(spot);
  if (!near.length) {
    el.innerHTML = `<p class="muted" style="font-size:0.82rem">Aucune balise OpenWindMap à moins de 20 km. Cherchez une balise FFVL ou Romma sur place.</p>`;
    return;
  }
  el.innerHTML = near.map(({ b, dist }) =>
    `<div class="beacon" data-id="${b.id}"><strong>${esc(b.name)}</strong>
     <span class="muted">à ${dist.toFixed(1)} km</span><div class="beacon-val">lecture...</div></div>`).join("");

  await Promise.all(near.map(async ({ b }) => {
    const row = el.querySelector(`.beacon[data-id="${b.id}"] .beacon-val`);
    try {
      const d = await (await fetch(`https://api.pioupiou.fr/v1/live/${b.id}`)).json();
      const m = d.data?.measurements;
      if (!m || m.wind_speed_avg == null) throw new Error("pas de mesure");
      const kmh = (x) => Math.round(x * 3.6);
      const age = Math.round((Date.now() - Date.parse(m.date)) / 60000);
      const dirName = m.wind_heading != null ? DIR_FR[dirFromDegrees(m.wind_heading)] : null;
      const stale = age > 60;
      row.innerHTML =
        `<span class="beacon-wind">${kmh(m.wind_speed_avg)} km/h</span>` +
        `<span class="muted"> (max ${kmh(m.wind_speed_max)})</span>` +
        (dirName ? ` ${fromDir(dirName)}` : "") +
        ` <span class="beacon-age${stale ? " stale" : ""}">${age < 60 ? `il y a ${age} min` : `il y a ${Math.round(age / 60)} h, à ignorer`}</span>`;
    } catch {
      row.innerHTML = `<span class="muted">mesure indisponible</span>`;
    }
  }));
}

// lien Météo-Parapente (modèle WRF 1,2 km) sur le spot, au jour et à l'heure choisis
function meteoParapenteUrl(spot, dayIdx, hour) {
  const d = forecastDates()[dayIdx] || new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hh = String(typeof hour === "number" ? hour : 13).padStart(2, "0");
  return `https://meteo-parapente.com/#/${spot.lat.toFixed(4)},${spot.lon.toFixed(4)},12/${iso}/${hh}00`;
}

// ---------- contrôles ----------
function renderPrefs() {
  const sportSel = $("#sport-select"), levelSel = $("#level-select");
  sportSel.innerHTML = Object.entries(SPORTS)
    .map(([k, v]) => `<option value="${k}" ${k === state.sport ? "selected" : ""}>${v.label}</option>`).join("");
  levelSel.innerHTML = LEVELS
    .map((l) => `<option value="${l}" ${l === state.level ? "selected" : ""}>${l[0].toUpperCase() + l.slice(1)}</option>`).join("");
  sportSel.onchange = () => { state.sport = sportSel.value; localStorage.setItem("pz_sport", state.sport); renderAll(); };
  levelSel.onchange = () => { state.level = levelSel.value; localStorage.setItem("pz_level", state.level); renderAll(); };
}

function renderDaySelect() {
  const days = forecastDates();
  const fmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const sel = $("#day-select");
  if (!days.length) { sel.innerHTML = "<option>Aujourd'hui</option>"; return; }
  if (state.day >= days.length) state.day = 0;
  sel.innerHTML = days.map((d, i) =>
    `<option value="${i}" ${i === state.day ? "selected" : ""}>${i === 0 ? "Aujourd'hui" : i === 1 ? "Demain" : fmt.format(d)}</option>`).join("");
  sel.onchange = () => { state.day = +sel.value; renderAll(); };
}

function renderHourChips() {
  const hours = ["auto", 8, 10, 12, 14, 16, 18, 20];
  $("#hour-chips").innerHTML = hours.map((h) =>
    `<button class="chip ${String(state.hour) === String(h) ? "active" : ""}" data-hour="${h}">
      ${h === "auto" ? "✨ Meilleur créneau" : h + " h"}</button>`).join("");
  $("#hour-chips").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.hour = b.dataset.hour === "auto" ? "auto" : +b.dataset.hour; renderAll(); };
  });
}

// ---------- carte ----------
let map, markersLayer;
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], 9);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 17,
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function renderMap(results) {
  markersLayer.clearLayers();
  for (const { spot, res } of results) {
    const m = L.circleMarker([spot.lat, spot.lon], {
      radius: res ? 8 : 5,
      color: "#ffffff", weight: 1.5,
      fillColor: res ? res.color : "#b9c6d6", fillOpacity: res ? 0.95 : 0.55,
    });
    m.bindPopup(
      `<strong>${esc(spot.name)}</strong><br>` +
      (res
        ? `<span class="popup-score" style="background:${res.color}">${res.score}</span> ${res.verdict}
           ${res.bestHour != null && state.hour === "auto" ? `- créneau le plus cohérent : ${res.bestHour} h` : ""}<br>`
        : spot.scorable ? "météo en cours de chargement...<br>"
        : "orientation du décollage inconnue : pas de score<br>") +
      `<a href="#/spot/${spot.slug}">Voir le détail →</a>`);
    m.addTo(markersLayer);
  }
  if (state.center) {
    L.circleMarker([state.center.lat, state.center.lon],
      { radius: 6, color: "#1f2b3a", fillColor: "#fff", fillOpacity: 1, weight: 2 })
      .bindTooltip("Vous êtes ici").addTo(markersLayer);
  }
}

// ---------- liste ----------
function computeResults() {
  return nearbySpots()
    .map(({ spot, dist }) => ({ spot, dist, res: scoreFor(spot, state.day, state.hour) }))
    .filter((r) => state.source === "live" || r.res);
}

function renderList(results) {
  const shown = results.slice(0, 60);
  if (!shown.length) {
    $("#spot-list").innerHTML = `<p class="muted">Aucun spot à moins de ${RADIUS_KM} km. Cherchez une autre ville.</p>`;
    return;
  }
  $("#spot-list").innerHTML = shown.map(({ spot, dist, res }) => {
    const wx = res ? wxAt(spot, state.day, res.bestHour ?? 12) : null;
    return `
    <div class="spot-card" data-slug="${spot.slug}">
      <div class="spot-thumb">${windRoseSVG(spot.orientations, wx?.windDir, 64, res?.color)}</div>
      <div class="spot-card-main">
        <h3>${esc(spot.name)}</h3>
        <div class="meta">${spot.altitude ? spot.altitude + " m · " : ""}${Math.round(dist)} km · déco ${orientationLabel(spot.orientations)}</div>
        <div class="badges">
          ${spot.ffvl_url ? '<span class="badge ffvl">fiche FFVL</span>' : ""}
          <span class="badge conf-${esc(spot.confidence)}">données ${esc(spot.confidence)}s</span>
          ${spot.thermals ? '<span class="badge">thermique</span>' : ""}
          ${spot.soaring ? '<span class="badge">soaring</span>' : ""}
        </div>
      </div>
      ${res
        ? `<div class="score-chip" style="background:${res.color}">
            <div class="n">${res.score}</div>
            <span class="v">${res.verdict}</span>
            ${state.hour === "auto" && res.bestHour != null && res.score > 0 ? `<span class="h">à ${res.bestHour} h</span>` : ""}
          </div>`
        : spot.scorable
          ? `<div class="score-chip loading"><div class="n">·</div><span class="v">chargement</span></div>`
          : `<div class="score-chip nodata"><div class="n">?</div><span class="v">données insuffisantes</span></div>`}
    </div>`;
  }).join("");
  $("#spot-list").querySelectorAll(".spot-card").forEach((el) => {
    el.onclick = () => { location.hash = `#/spot/${el.dataset.slug}`; };
  });
}

function renderStatus(results) {
  const when = state.meta?.fetched_at ? new Date(state.meta.fetched_at) : null;
  const fmt = when ? when.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "...";
  const scored = results.filter((r) => r.res).length;
  $("#wx-status").innerHTML =
    `${state.source === "live" ? "🟢 Prévisions en direct" : "🕓 Archive"} · ` +
    `${scored} spots les plus proches${state.center ? ` de ${esc(state.center.label)}` : ""} · relevé du ${fmt}`;
}

// ---------- page spot ----------
function renderSpotPage(slug) {
  const spot = state.spots.find((s) => s.slug === slug);
  const el = $("#view-spot");
  if (!spot) { el.innerHTML = "<p>Spot introuvable. <a href='#/'>← Retour</a></p>"; return; }
  if (!state.fc.has(slug)) {
    el.innerHTML = `<a class="back-link" href="#/">← Retour à la liste</a>
      <div class="spot-page"><h1>${esc(spot.name)}</h1><p class="muted">Chargement de la météo...</p></div>`;
    loadLive([{ spot, dist: 0 }]).then((ok) => { if (ok) renderSpotPage(slug); });
    return;
  }

  const dayRes = scoreFor(spot, state.day, "auto");
  const hour = state.hour === "auto" ? (dayRes?.bestHour ?? 13) : state.hour;
  const wx = wxAt(spot, state.day, hour);
  const res = wx ? scoreSpotHour(spot, wx, { sport: state.sport, level: state.level }) : null;
  const days = forecastDates();
  const fmtDay = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  const factorsHTML = res ? res.factors.map((f) => `
    <div class="factor ${f.gate && f.score === 0 ? "gate-fail" : ""}">
      <div class="factor-head">
        <span class="name">${esc(f.label)} ${f.gate && f.score === 0 ? '<span class="gate-tag">ÉLIMINATOIRE</span>' : ""}</span>
        <div class="factor-bar"><i style="width:${Math.round(f.score * 100)}%;background:${f.score === 0 ? "#ef4444" : f.score < 0.5 ? "#fb923c" : f.score < 0.8 ? "#fbbf24" : "#10b981"}"></i></div>
        <span class="val">${Math.round(f.score * 100)}/100 · poids ${f.weight}</span>
      </div>
      <p>${esc(f.detail)}</p>
    </div>`).join("") : "<p class='muted'>Pas de données météo pour ce créneau.</p>";

  const hourStrip = HOURS_SHOWN.map((hh) => {
    const w = wxAt(spot, state.day, hh);
    if (!w) return "";
    const r = scoreSpotHour(spot, w, { sport: state.sport, level: state.level });
    return `<div class="hour-cell ${hh === hour ? "active" : ""}" data-h="${hh}" style="background:${r.color}">
      ${hh}h<span class="s">${r.score}</span></div>`;
  }).join("");

  const srcLabels = { paraglidingearth: "ParaglidingEarth", osm: "OpenStreetMap", ffvl: "FFVL", petitoizo: "Petitoizo" };

  el.innerHTML = `
    <a class="back-link" href="#/">← Retour à la liste</a>
    <div class="spot-page">
      <div class="spot-head">
        <div style="display:flex;gap:16px;align-items:flex-start">
          <div>${windRoseSVG(spot.orientations, wx?.windDir, 92, res?.color)}</div>
          <div>
            <h1>${esc(spot.name)}</h1>
            <div class="meta">
              Décollage ${spot.altitude ? spot.altitude + " m" : "altitude inconnue"} · orientation ${orientationLabel(spot.orientations)}
              ${spot.landing?.altitude != null ? ` · atterrissage ${spot.landing.altitude} m` : ""}<br>
              Données <strong class="conf-${esc(spot.confidence)}">${esc(spot.confidence)}s</strong>${
                spot.missing?.length ? ` (manque : ${esc(spot.missing.join(", "))})` : ""}
              ${spot.club ? `<br>Club : ${esc(spot.club)}` : ""}
            </div>
            <div class="transport-tags">
              ${(spot.transport || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}
              ${(spot.sources || []).map((s) => `<span class="badge src">${esc(srcLabels[s] || s)}</span>`).join("")}
            </div>
          </div>
        </div>
        ${res ? `<div class="big-score" style="background:${res.color}">
          <div class="n">${res.score}</div><span class="v">${res.verdict}</span>
          <span class="v">${fmtDay.format(days[state.day])} · ${hour} h</span>
        </div>` : ""}
      </div>

      <div class="hour-strip">${hourStrip}</div>
      <p class="muted" style="font-size:0.75rem;margin:2px 0 0">Score heure par heure - cliquez sur un créneau. ${dayRes?.bestHour != null ? `Meilleur créneau du jour : <strong>${dayRes.bestHour} h (${dayRes.score}/100)</strong>.` : ""}</p>

      <h2 class="section-title">🧮 Comment lire ce chiffre</h2>
      <p class="not-a-greenlight">Ce n'est pas un feu vert. Le chiffre dit seulement à quel point
      les conditions <em>prévues par le modèle</em> collent aux caractéristiques connues du site,
      pour un pilote ${esc(state.level)} en ${esc(SPORTS[state.sport].label.toLowerCase())}.
      Il ignore l'aérologie locale, la réglementation, l'état du terrain et votre forme du jour.</p>
      <p class="explain-intro">${res ? buildScoreNarrative(res) : ""}</p>
      ${factorsHTML}
      <p class="explain-intro" style="margin-top:10px">
        Le score combine tous ces facteurs : une moyenne pondérée mesure la qualité d'ensemble, puis le
        <em>pire</em> facteur tire le score vers le bas - car en vol libre, une seule mauvaise condition suffit
        à rendre un vol dangereux. Un facteur « éliminatoire » à zéro (pluie, vent de cul, vent trop fort...)
        met directement le score à 0. <a href="#/methodo">Méthodologie complète →</a>
      </p>

      <div class="checklist">
        <h4>Avant de décoller, ce que Petitoizo ne sait pas</h4>
        <ul>
          <li><strong>L'accès et la réglementation.</strong> Certains sites sont soumis à convention,
          autorisation militaire ou fermeture saisonnière. Vérifiez la fiche FFVL et le club local.</li>
          <li><strong>L'aérologie fine.</strong> Brises de pente, venturis, rotors et confluences ne
          sont pas dans une maille de 1,3 km.</li>
          <li><strong>L'état du terrain.</strong> Atterrissage fauché ou non, troupeaux, câbles, travaux.</li>
          <li><strong>Vous.</strong> Fatigue, matériel, dernier vol il y a six mois.</li>
        </ul>
        <p>Les balises, la manche à air et les pilotes présents sur place restent la seule vérité.
        ${spot.confidence === "insuffisante" || spot.confidence === "limitée"
          ? `<br><strong>Sur ce spot en particulier, nos données sont ${esc(spot.confidence)}s${spot.missing?.length ? ` : il nous manque ${spot.missing.join(", ")}` : ""}.</strong>`
          : ""}</p>
      </div>

      <div class="spot-grid">
        <div>
          ${spot.fr_notes ? `<div class="info-block"><h4>Le spot en bref</h4><p>${esc(spot.fr_notes)}</p></div>` : ""}
          ${spot.takeoff_description ? `<div class="info-block"><h4>Décollage</h4><p>${esc(spot.takeoff_description)}</p></div>` : ""}
          ${spot.landing ? `<div class="info-block"><h4>Atterrissage</h4><p>${esc(spot.landing.name)}${spot.landing.description ? " - " + esc(spot.landing.description) : ""}</p></div>` : ""}
          ${spot.transport_notes || spot.going_there ? `<div class="info-block"><h4>Y aller</h4><p>${esc(spot.transport_notes || spot.going_there)}</p></div>` : ""}
          ${spot.weather_notes ? `<div class="info-block"><h4>Aérologie locale (notes pilotes)</h4><p>${esc(spot.weather_notes)}</p></div>` : ""}
          ${spot.flight_rules ? `<div class="info-block"><h4>Espace aérien / accès</h4><p>${esc(spot.flight_rules)}</p></div>` : ""}
          ${spot.comments ? `<div class="info-block"><h4>Commentaires pilotes</h4><p>${esc(spot.comments)}</p></div>` : ""}
        </div>
        <div>
          ${wx ? `<div class="info-block"><h4>Météo du créneau (${hour} h)</h4>
            <p>💨 Vent au sol : <strong>${wx.windSpeed} km/h</strong> ${fromDir(DIR_FR[dirFromDegrees(wx.windDir)])} (${wx.windDir}°)
Rafales : ${wx.windGusts} km/h
🎈 Vent météo : ${wx.windMeta} km/h à 1 500 m · ${wx.wind700 ?? "?"} km/h à 3 000 m
🌡 ${wx.temp} °C · ☁️ ${wx.cloudcover} % (bas : ${wx.cloudLow ?? "?"} %) · 🌧 ${wx.precip.toFixed(1)} mm (prob. ${wx.precipProb ?? "?"} %)
🪂 Plafond de la couche convective : ${wx.blh != null ? `${wx.blh} m sol, soit ~${Math.round((wx.elevation || 0) + wx.blh)} m d'altitude` : "?"}
❄️ Iso 0 °C : ${wx.freezing ?? "?"} m · ⚡ CAPE : ${wx.cape ?? 0} J/kg</p></div>` : ""}
          <div class="info-block beacons-block"><h4>🛰 Vent mesuré à proximité (OpenWindMap)</h4>
            <div id="beacons-live"></div>
            <p class="muted" style="font-size:0.75rem;margin-top:6px">Mesures réelles des balises communautaires. En cas de désaccord avec le modèle, c'est la balise qui a raison.</p>
          </div>
          <div class="info-block"><h4>Aller plus loin</h4>
            <p><a href="${meteoParapenteUrl(spot, state.day, hour)}" target="_blank" rel="noopener">Météo-Parapente sur ce spot ↗</a>
<span class="muted" style="font-size:0.78rem">(modèle WRF 1,2 km, la référence des pilotes)</span>${
  spot.ffvl_url ? `\n<a href="${esc(spot.ffvl_url)}" target="_blank" rel="noopener">Fiche officielle FFVL ↗</a>` : ""}${
  spot.pge_link ? `\n<a href="${esc(spot.pge_link)}" target="_blank" rel="noopener">Fiche ParaglidingEarth ↗</a>` : ""}${
  spot.club_url ? `\n<a href="${esc(spot.club_url)}" target="_blank" rel="noopener">Club local ↗</a>` : ""}
<a href="https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lon}" target="_blank" rel="noopener">Itinéraire vers le décollage ↗</a></p>
          </div>
          <div class="info-block"><h4>Caractéristiques</h4>
            <p>${[spot.thermals && "Site thermique", spot.soaring && "Soaring possible", spot.xc && "Départ de cross",
              spot.hanggliding && "Delta autorisé", spot.hike && "Marche d'approche",
              spot.official && "Site officiel déclaré"].filter(Boolean).join("\n") || "Non renseigné"}</p>
          </div>
        </div>
      </div>
    </div>`;

  el.querySelectorAll(".hour-cell").forEach((c) => {
    c.onclick = () => { state.hour = +c.dataset.h; renderSpotPage(slug); };
  });
  renderBeacons(spot, "beacons-live");
}

function buildScoreNarrative(res) {
  const worst = [...res.factors].sort((a, b) => a.score - b.score)[0];
  const good = res.factors.filter((f) => f.score >= 0.8).length;
  if (res.score === 0) {
    const gates = res.factors.filter((f) => f.gate && f.score === 0).map((f) => f.label.toLowerCase());
    return `Le score est de 0 car au moins une condition de sécurité n'est pas remplie (${gates.join(", ")}). ` +
      `Ces conditions ne se négocient pas, quel que soit le niveau du pilote.`;
  }
  if (res.score >= 80) return `${good} facteurs sur ${res.factors.length} sont dans les clous du modèle. Cela ne dit pas que le vol est bon, seulement qu'aucune donnée prévue ne s'oppose au profil du site. Le facteur le plus juste reste « ${worst.label} » (${Math.round(worst.score * 100)}/100).`;
  if (res.score >= 60) return `Le modèle ne signale rien de rédhibitoire, mais le facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100) tire l'ensemble vers le bas. Lisez son explication avant toute décision.`;
  if (res.score >= 40) return `Conditions mitigées dans le modèle : « ${worst.label} » (${Math.round(worst.score * 100)}/100) pèse fortement. Cela demande de l'expérience du site et une vraie observation sur place.`;
  return `Le modèle décrit des conditions défavorables, principalement à cause de « ${worst.label} » (${Math.round(worst.score * 100)}/100).`;
}


// ---------- méthodologie ----------
function renderMethodoPage() {
  $("#view-spot").innerHTML = `
    <a class="back-link" href="#/">← Retour à la liste</a>
    <div class="methodo">
      <h1>Comment le score est-il calculé ?</h1>
      <p>Le score (0-100) estime si les conditions permettent de voler <strong>en sécurité</strong> sur un spot donné,
      à une heure donnée, pour un sport et un niveau de pilote donnés. Il croise les caractéristiques du site
      (orientation du décollage, altitude, réputation thermique) avec les prévisions météo horaires.</p>

      <p class="not-a-greenlight">Petitoizo ne recommande jamais de voler et ne classe pas les spots
      par étoiles. Le chiffre décrit un écart entre des conditions prévues et les caractéristiques
      connues d'un site. La décision de décoller n'appartient qu'au pilote, sur place.</p>

      <h2>Les données météo</h2>
      <p>Uniquement des modèles <strong>Météo-France</strong> via Open-Meteo : <strong>AROME 1,3 km</strong>
      pour les deux premiers jours, puis <strong>ARPEGE</strong>, soit environ <strong>4 jours</strong> d'échéance.
      C'est volontairement plus court qu'avant : au-delà, il fallait basculer sur des modèles globaux
      bien moins fins, et l'horizon utile en vol libre dépasse rarement 2 à 4 jours.
      Chaque interrogation précise <strong>l'altitude réelle du décollage</strong>, ce qui corrige les valeurs par
      rapport au relief lissé du modèle - un décollage à 1 900 m n'a pas la météo du fond de vallée.</p>
      <p><strong>Balises OpenWindMap.</strong> Chaque fiche de spot affiche le vent <em>réellement mesuré</em>
      par les balises communautaires situées à moins de 20 km, avec l'heure de la mesure. Un modèle prévoit,
      une balise constate : en cas de désaccord, c'est la balise qui a raison.</p>
      <p>Pour l'analyse fine (émagramme, ascendances, couches), rien ne remplace
      <a href="https://meteo-parapente.com" target="_blank" rel="noopener">Météo-Parapente</a> et son modèle WRF 1,2 km :
      chaque fiche de spot contient un lien direct vers le bon point, au bon jour et à la bonne heure.</p>

      <h2>Les 8 facteurs</h2>
      <table>
        <tr><th>Facteur</th><th>Poids</th><th>Éliminatoire</th><th>Règle</th></tr>
        <tr><td>Jour / nuit</td><td>-</td><td>oui</td><td>Le vol libre se pratique de jour (VFR).</td></tr>
        <tr><td>Précipitations</td><td>2</td><td>oui</td><td>Pluie : une voile mouillée peut décrocher.</td></tr>
        <tr><td>Orientation du vent</td><td>3</td><td>oui</td><td><strong>Vent de cul : score 0.</strong> Face idéale : 100. Travers pénalisé. Vent &lt; 5 km/h : l'orientation importe peu.</td></tr>
        <tr><td>Force du vent</td><td>3</td><td>oui</td><td>Fenêtre idéale selon sport et niveau (parapente débutant : 5-14 km/h, maxi 20).</td></tr>
        <tr><td>Rafales</td><td>2,5</td><td>oui</td><td>Écart rafales / vent moyen élevé = masse d'air turbulente.</td></tr>
        <tr><td>Vent d'altitude (850 hPa)</td><td>2</td><td>oui</td><td>Vent météo fort en altitude = turbulences sous le vent et dérive arrière, même si la brise au sol est douce.</td></tr>
        <tr><td>Risque orageux (CAPE)</td><td>1,5</td><td>oui</td><td>CAPE au-delà de 1 800 J/kg : risque de cumulonimbus.</td></tr>
        <tr><td>Aérologie du créneau</td><td>1,5</td><td>non</td><td>Croise l'heure, la saison, le plafond de la couche convective et le niveau du pilote.</td></tr>
      </table>

      <h2>Agrégation</h2>
      <p><code>score = 100 × moyenne pondérée × (0,4 + 0,6 × pire facteur)</code></p>
      <p>La moyenne mesure la qualité d'ensemble ; le terme « pire facteur » traduit une règle d'or du vol libre :
      <em>une seule condition mauvaise suffit à rendre un vol dangereux</em>.</p>

      <h2>Les spots</h2>
      <p>Deux sources fusionnées et recoupées : <strong>ParaglidingEarth</strong> (base communautaire mondiale) et
      <strong>OpenStreetMap</strong>, dont les sites de vol libre français proviennent largement de l'import FFVL -
      d'où les liens vers les fiches officielles <em>federation.ffvl.fr</em>, les clubs gestionnaires et les
      atterrissages. Quand un spot existe dans les deux bases, les orientations sont fusionnées et l'information
      la plus complète l'emporte.</p>

      <h2>Ce qu'on affiche, ce qu'on n'affiche pas</h2>
      <p>Tout le texte d'une fiche vient des sources, jamais d'une rédaction maison : décrire un site
      qu'on n'a pas volé conduit à écrire des choses fausses. Chaque spot porte un niveau de
      <strong>confiance</strong> (bonnes, moyennes, limitées, insuffisantes) et la liste de ce qui manque.
      <strong>Les spots dont l'orientation de décollage est inconnue ne reçoivent aucun score</strong> :
      sans orientation, impossible de dire si le vent est de face ou de cul, et un chiffre inventé
      serait pire que pas de chiffre.</p>
      <p>Les entrées qui sont en réalité des atterrissages sont écartées automatiquement (nom explicite,
      ou point sans orientation ni description situé en fond de vallée sous un décollage voisin).</p>

      <h2>Limites</h2>
      <p>La maille des modèles (1 à 11 km selon l'échéance) ne résout pas les effets très locaux
      (brises de pente, venturis, confluences). Les orientations sont des données communautaires, parfois
      incomplètes. <strong>Petitoizo ne remplace ni les balises FFVL, ni la manche à air, ni l'avis des
      pilotes locaux.</strong></p>
    </div>`;
}

// ---------- recherche ville + géoloc ----------
function setCenter(lat, lon, label, zoom = 10) {
  state.center = { lat, lon, label };
  map.setView([lat, lon], zoom);
  ensureForecasts();
}

function setupCitySearch() {
  const input = $("#city-input"), box = $("#city-suggestions");
  let t;
  input.oninput = () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.add("hidden"); return; }
    t = setTimeout(async () => {
      try {
        const res = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(q)}&fields=nom,centre,codesPostaux,departement&boost=population&limit=6`);
        const cities = await res.json();
        box.innerHTML = cities.map((c) =>
          `<div data-lat="${c.centre.coordinates[1]}" data-lon="${c.centre.coordinates[0]}" data-name="${esc(c.nom)}">
            ${esc(c.nom)} <span class="muted">${esc(c.departement?.nom || c.codesPostaux?.[0] || "")}</span></div>`).join("");
        box.classList.toggle("hidden", cities.length === 0);
        box.querySelectorAll("div[data-lat]").forEach((d) => {
          d.onclick = () => {
            input.value = d.dataset.name;
            box.classList.add("hidden");
            setCenter(+d.dataset.lat, +d.dataset.lon, d.dataset.name);
          };
        });
      } catch { box.classList.add("hidden"); }
    }, 250);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { box.querySelector("div[data-lat]")?.click(); e.preventDefault(); }
    if (e.key === "Escape") box.classList.add("hidden");
  };
  document.addEventListener("click", (e) => { if (!box.contains(e.target) && e.target !== input) box.classList.add("hidden"); });

  const geoBtn = $("#btn-geoloc");
  geoBtn.onclick = () => {
    if (!navigator.geolocation) { alert("Géolocalisation indisponible - cherchez une ville."); return; }
    geoBtn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        geoBtn.classList.remove("busy");
        const { latitude: lat, longitude: lon } = pos.coords;
        input.value = "📍 Ma position";
        let label = "ma position";
        try {
          const r = await fetch(`https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=nom&limit=1`);
          const [commune] = await r.json();
          if (commune?.nom) { label = commune.nom; input.value = `📍 ${commune.nom}`; }
        } catch { /* libellé générique */ }
        box.classList.add("hidden");
        setCenter(lat, lon, label);
      },
      () => { geoBtn.classList.remove("busy"); alert("Impossible de vous géolocaliser - cherchez une ville à la place."); },
      { timeout: 8000 });
  };
}

// ---------- archives ----------
function setupSnapshots() {
  const sel = $("#snapshot-select");
  const archives = state.index?.archives || [];
  const fmt = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  sel.innerHTML = `<option value="live">en direct (dernières prévisions)</option>` +
    archives.map((a) => `<option value="${a.file}">archive du ${fmt(a.fetched_at)}</option>`).join("");
  sel.onchange = async () => {
    if (sel.value === "live") {
      state.source = "live";
      state.fc = new Map(); state.loadedCells = new Set(); state.liveDone = new Set(); state.meta = null;
      await ensureForecasts();
    } else {
      try {
        const d = await (await fetch(`data/forecasts/archive/${sel.value}`)).json();
        state.source = sel.value;
        state.meta = { time_start: d.time_start, hours: d.hours, fetched_at: d.fetched_at, model: d.model };
        state.fc = new Map(Object.entries(d.spots));
        state.day = 0;
        renderAll();
      } catch { alert("Archive indisponible."); }
    }
  };
}

// ---------- rendu / routage ----------
function renderAll() {
  const hash = location.hash || "#/";
  renderDaySelect();
  renderHourChips();
  if (hash.startsWith("#/spot/")) { renderSpotPage(decodeURIComponent(hash.slice(7))); return; }
  if (hash.startsWith("#/methodo")) { renderMethodoPage(); return; }
  const results = computeResults();
  renderMap(results);
  renderList(results);
  renderStatus(results);
}

function route() {
  const hash = location.hash || "#/";
  const detail = hash.startsWith("#/spot/") || hash.startsWith("#/methodo");
  $("#view-list").classList.toggle("hidden", detail);
  $("#view-spot").classList.toggle("hidden", !detail);
  renderAll();
  window.scrollTo(0, 0);
}

// ---------- disclosure d'accueil ----------
// Affichée une seule fois : le choix est mémorisé dans le navigateur.
const DISCLOSURE_KEY = "pz_disclosure_v1";
function setupDisclosure() {
  const modal = $("#disclosure");
  if (!modal) return;
  try {
    if (localStorage.getItem(DISCLOSURE_KEY)) return;
  } catch { return; } // navigation privée verrouillée : on n'insiste pas
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");

  const check = $("#disclosure-check"), ok = $("#disclosure-ok");
  check.onchange = () => { ok.disabled = !check.checked; };
  ok.onclick = () => {
    try { localStorage.setItem(DISCLOSURE_KEY, new Date().toISOString()); } catch { /* tant pis */ }
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");
  };
}

// ---------- init ----------
async function init() {
  setupDisclosure();
  renderPrefs();
  initMap();
  setupCitySearch();

  const [spotsData, index, beaconsData] = await Promise.all([
    fetch("data/spots.json").then((r) => r.json()),
    fetch("data/forecasts/index.json").then((r) => r.json()).catch(() => null),
    fetch("data/beacons.json").then((r) => r.json()).catch(() => null),
  ]);
  state.beacons = beaconsData?.beacons || [];
  state.spots = spotsData.spots;
  state.index = index;
  if (index) state.meta = { time_start: index.time_start, hours: index.hours, fetched_at: index.fetched_at, model: index.model };
  const counter = $("#spot-count");
  if (counter) counter.textContent = `${state.spots.length} spots en France`;

  setupSnapshots();
  window.addEventListener("hashchange", route);
  route();
  await ensureForecasts();
}

init();
