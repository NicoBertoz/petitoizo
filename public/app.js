import {
  SPORTS, LEVELS, scoreSpotHour, scoreSpotDay, dirFromDegrees, DIR_FR, fromDir, orientationLabel,
} from "./scoring.js?v=3";

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
      `&hourly=${API_VARS.join(",")}&forecast_days=8&timezone=auto&windspeed_unit=kmh`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      (Array.isArray(data) ? data : [data]).forEach((d, j) => {
        const spot = chunk[j], h = d.hourly;
        state.meta = {
          time_start: h.time[0], hours: h.time.length, fetched_at: new Date().toISOString(),
          model: "Open-Meteo en direct (AROME 1 km / ARPEGE / ICON), downscalé à l'altitude du décollage",
        };
        state.fc.set(spot.slug, {
          e: Math.round(d.elevation ?? spot.altitude ?? 0),
          v: API_VARS.map((name, k) =>
            h[name].map((x) => (x == null ? null : VARS[k] === "p" ? Math.round(x * 10) : Math.round(x)))),
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
      radius: spot.famous ? 10 : 7,
      color: "#ffffff", weight: 1.5,
      fillColor: res ? res.color : "#b9c6d6", fillOpacity: res ? 0.95 : 0.6,
    });
    m.bindPopup(
      `<strong>${esc(spot.name)}</strong><br>` +
      (res
        ? `<span class="popup-score" style="background:${res.color}">${res.score}</span> ${res.emoji ?? ""} ${res.verdict}
           ${res.bestHour != null && state.hour === "auto" ? `- meilleur créneau ${res.bestHour} h` : ""}<br>`
        : "météo en cours de chargement...<br>") +
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
          ${spot.famous ? '<span class="badge star">★ site majeur</span>' : ""}
          ${spot.ffvl_url ? '<span class="badge ffvl">FFVL</span>' : ""}
          <span class="badge">${esc(spot.level_min)}</span>
          ${spot.thermals ? '<span class="badge">thermique</span>' : ""}
          ${spot.soaring ? '<span class="badge">soaring</span>' : ""}
        </div>
      </div>
      ${res
        ? `<div class="score-chip" style="background:${res.color}">
            <div class="n">${res.score}</div>
            <span class="v">${res.emoji ?? ""} ${res.verdict}</span>
            ${state.hour === "auto" && res.bestHour != null && res.score > 0 ? `<span class="h">à ${res.bestHour} h</span>` : ""}
          </div>`
        : `<div class="score-chip loading"><div class="n">·</div><span class="v">chargement</span></div>`}
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
              Niveau conseillé : <strong>${esc(spot.level_min)}</strong>${spot.famous ? " · ★ site majeur" : ""}
              ${spot.club ? `<br>Club : ${esc(spot.club)}` : ""}
            </div>
            <div class="transport-tags">
              ${(spot.transport || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}
              ${(spot.sources || []).map((s) => `<span class="badge src">${esc(srcLabels[s] || s)}</span>`).join("")}
            </div>
          </div>
        </div>
        ${res ? `<div class="big-score" style="background:${res.color}">
          <div class="n">${res.score}</div><span class="v">${res.emoji ?? ""} ${res.verdict}</span>
          <span class="v">${fmtDay.format(days[state.day])} · ${hour} h</span>
        </div>` : ""}
      </div>

      <div class="hour-strip">${hourStrip}</div>
      <p class="muted" style="font-size:0.75rem;margin:2px 0 0">Score heure par heure - cliquez sur un créneau. ${dayRes?.bestHour != null ? `Meilleur créneau du jour : <strong>${dayRes.bestHour} h (${dayRes.score}/100)</strong>.` : ""}</p>

      <h2 class="section-title">🧮 Pourquoi ce score ?</h2>
      <p class="explain-intro">${res ? buildScoreNarrative(res) : ""}</p>
      ${factorsHTML}
      <p class="explain-intro" style="margin-top:10px">
        Le score combine tous ces facteurs : une moyenne pondérée mesure la qualité d'ensemble, puis le
        <em>pire</em> facteur tire le score vers le bas - car en vol libre, une seule mauvaise condition suffit
        à rendre un vol dangereux. Un facteur « éliminatoire » à zéro (pluie, vent de cul, vent trop fort...)
        met directement le score à 0. <a href="#/methodo">Méthodologie complète →</a>
      </p>

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
}

function buildScoreNarrative(res) {
  const worst = [...res.factors].sort((a, b) => a.score - b.score)[0];
  const good = res.factors.filter((f) => f.score >= 0.8).length;
  if (res.score === 0) {
    const gates = res.factors.filter((f) => f.gate && f.score === 0).map((f) => f.label.toLowerCase());
    return `Le score est de 0 car au moins une condition de sécurité n'est pas remplie (${gates.join(", ")}). ` +
      `En vol libre, ces conditions ne se négocient pas, quel que soit le niveau du pilote. Le détail de chaque facteur est expliqué ci-dessous.`;
  }
  if (res.score >= 80) return `${good} facteurs sur ${res.factors.length} sont au vert : les conditions de ce créneau sont très favorables pour un pilote ${state.level} en ${SPORTS[state.sport].label.toLowerCase()}. Chaque facteur est détaillé ci-dessous.`;
  if (res.score >= 60) return `Les conditions sont globalement bonnes, mais le facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100) limite le score. Lisez son explication ci-dessous avant de décider.`;
  if (res.score >= 40) return `Conditions mitigées : le facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100) pèse fortement sur le score. Ce n'est pas forcément non-volable, mais cela demande de l'expérience et de la vigilance.`;
  return `Conditions défavorables, principalement à cause du facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100). Mieux vaut choisir un autre créneau ou un autre site - le détail ci-dessous explique pourquoi.`;
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

      <h2>Les données météo</h2>
      <p>Open-Meteo, qui agrège les meilleurs modèles disponibles selon l'échéance : <strong>AROME 1 km</strong>
      (Météo-France) pour les deux premiers jours, <strong>ARPEGE</strong> jusqu'à 4 jours, puis ICON / ECMWF au-delà.
      Chaque interrogation précise <strong>l'altitude réelle du décollage</strong>, ce qui corrige les valeurs par
      rapport au relief lissé du modèle - un décollage à 1 900 m n'a pas la météo du fond de vallée.</p>
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

// ---------- init ----------
async function init() {
  renderPrefs();
  initMap();
  setupCitySearch();

  const [spotsData, index] = await Promise.all([
    fetch("data/spots.json").then((r) => r.json()),
    fetch("data/forecasts/index.json").then((r) => r.json()).catch(() => null),
  ]);
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
