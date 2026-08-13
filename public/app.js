import {
  SPORTS, LEVELS, scoreSpotHour, scoreSpotDay, dirFromDegrees, DIR_FR, fromDir, orientationLabel,
} from "./scoring.js";

// ---------- état ----------
const state = {
  sport: localStorage.getItem("pz_sport") || "parapente",
  level: localStorage.getItem("pz_level") || "intermédiaire",
  day: 0,
  hour: "auto", // "auto" = meilleur créneau de la journée
  center: null, // {lat, lon, label}
  snapshot: "live",
  spots: [],
  forecasts: null, // {slug: {hourly}}
  fetchedAt: null,
  liveForecasts: null,
  liveFetchedAt: null,
  snapshotIndex: [],
};

const DEFAULT_CENTER = { lat: 45.35, lon: 5.85, label: "entre Grenoble et Chambéry" };
const HOURS_SHOWN = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const $ = (sel) => document.querySelector(sel);

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
const HOURLY_VARS = [
  "temperature_2m", "precipitation", "precipitation_probability", "cloudcover",
  "windspeed_10m", "winddirection_10m", "windgusts_10m",
  "windspeed_850hPa", "winddirection_850hPa", "cape", "is_day",
].join(",");

async function fetchLiveForecasts(spots) {
  const out = {};
  for (let i = 0; i < spots.length; i += 40) {
    const chunk = spots.slice(i, i + 40);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${chunk.map((s) => s.lat.toFixed(4)).join(",")}` +
      `&longitude=${chunk.map((s) => s.lon.toFixed(4)).join(",")}` +
      `&hourly=${HOURLY_VARS}&forecast_days=8&timezone=Europe%2FParis&windspeed_unit=kmh`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    (Array.isArray(data) ? data : [data]).forEach((d, j) => { out[chunk[j].slug] = { hourly: d.hourly }; });
  }
  return out;
}

function wxAt(spot, dayIdx, hour) {
  const fc = state.forecasts?.[spot.slug];
  if (!fc) return null;
  const h = fc.hourly;
  const i = dayIdx * 24 + hour;
  if (i >= h.time.length) return null;
  return {
    windSpeed: h.windspeed_10m[i], windDir: h.winddirection_10m[i], windGusts: h.windgusts_10m[i],
    windMeta: h.windspeed_850hPa?.[i], windMetaDir: h.winddirection_850hPa?.[i],
    precip: h.precipitation[i] ?? 0, precipProb: h.precipitation_probability?.[i],
    cloudcover: h.cloudcover?.[i], cape: h.cape?.[i], temp: h.temperature_2m?.[i],
    isDay: h.is_day?.[i] ?? 1, hour, month: +h.time[i].slice(5, 7), time: h.time[i],
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
  const anySlug = state.spots[0]?.slug;
  const t0 = state.forecasts?.[anySlug]?.hourly?.time?.[0];
  if (!t0) return [];
  const base = new Date(t0.slice(0, 10) + "T12:00:00");
  return Array.from({ length: 8 }, (_, i) => {
    const d = new Date(base); d.setDate(d.getDate() + i); return d;
  });
}

// ---------- SVG rose des vents ----------
function windRoseSVG(orientations, windDir, size = 64, score = null, color = null) {
  const c = size / 2, rOut = c - 2, rIn = size * 0.14;
  const sectors = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  let paths = "";
  sectors.forEach((s, i) => {
    const rating = orientations?.[s] ?? 0;
    const a0 = (i * 45 - 112.5) * (Math.PI / 180), a1 = (i * 45 - 67.5) * (Math.PI / 180);
    const r = rIn + (rOut - rIn) * (rating === 2 ? 1 : rating === 1 ? 0.62 : 0.22);
    const fill = rating === 2 ? "#2563eb" : rating === 1 ? "#93b4f5" : "#dde4ec";
    const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0);
    const x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
    paths += `<path d="M${c},${c} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${fill}"/>`;
  });
  let arrow = "";
  if (windDir != null) {
    // flèche dans le sens où va le vent (vient de windDir)
    const ang = ((windDir + 180) % 360 - 90) * (Math.PI / 180);
    const x = c + (rOut - 4) * Math.cos(ang), y = c + (rOut - 4) * Math.sin(ang);
    const xt = c - (rOut - 10) * Math.cos(ang), yt = c - (rOut - 10) * Math.sin(ang);
    arrow = `<line x1="${xt.toFixed(1)}" y1="${yt.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
      stroke="${color || "#1c2733"}" stroke-width="3" stroke-linecap="round" marker-end="url(#ah)"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><marker id="ah" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="${color || "#1c2733"}"/></marker></defs>
    ${paths}
    <text x="${c}" y="9" text-anchor="middle" font-size="8" fill="#61707f">N</text>
    ${arrow}
  </svg>`;
}

// ---------- rendu : contrôles ----------
function renderPrefs() {
  const sportSel = $("#sport-select"), levelSel = $("#level-select");
  sportSel.innerHTML = Object.entries(SPORTS)
    .map(([k, v]) => `<option value="${k}" ${k === state.sport ? "selected" : ""}>${v.label}</option>`).join("");
  levelSel.innerHTML = LEVELS
    .map((l) => `<option value="${l}" ${l === state.level ? "selected" : ""}>${l[0].toUpperCase() + l.slice(1)}</option>`).join("");
  sportSel.onchange = () => { state.sport = sportSel.value; localStorage.setItem("pz_sport", state.sport); rerender(); };
  levelSel.onchange = () => { state.level = levelSel.value; localStorage.setItem("pz_level", state.level); rerender(); };
}

function renderDayChips() {
  const days = forecastDates();
  const fmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const today = new Date().toISOString().slice(0, 10);
  $("#day-chips").innerHTML = days.map((d, i) => {
    const iso = d.toISOString().slice(0, 10);
    const label = iso === today ? "Aujourd'hui" : fmt.format(d);
    return `<button class="chip ${i === state.day ? "active" : ""}" data-day="${i}">${label}</button>`;
  }).join("");
  $("#day-chips").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.day = +b.dataset.day; rerender(); };
  });
}

function renderHourChips() {
  const hours = ["auto", 8, 10, 12, 14, 16, 18, 20];
  $("#hour-chips").innerHTML = hours.map((h) =>
    `<button class="chip ${String(state.hour) === String(h) ? "active" : ""}" data-hour="${h}">
      ${h === "auto" ? "✨ Meilleur créneau" : h + " h"}</button>`).join("");
  $("#hour-chips").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.hour = b.dataset.hour === "auto" ? "auto" : +b.dataset.hour; rerender(); };
  });
}

// ---------- carte ----------
let map, markersLayer;
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 17,
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function renderMap(results) {
  markersLayer.clearLayers();
  for (const { spot, res } of results) {
    if (!res) continue;
    const m = L.circleMarker([spot.lat, spot.lon], {
      radius: spot.famous ? 10 : 7,
      color: "#ffffff", weight: 1.5, fillColor: res.color, fillOpacity: 0.95,
    });
    m.bindPopup(
      `<strong>${esc(spot.name)}</strong><br>
       <span class="popup-score" style="background:${res.color}">${res.score}</span> ${res.verdict}
       ${res.bestHour != null && state.hour === "auto" ? `— meilleur créneau ${res.bestHour} h` : ""}<br>
       <a href="#/spot/${spot.slug}">Voir le détail →</a>`);
    m.addTo(markersLayer);
  }
  if (state.center) {
    L.circleMarker([state.center.lat, state.center.lon],
      { radius: 6, color: "#1c2733", fillColor: "#fff", fillOpacity: 1, weight: 2 })
      .bindTooltip("Vous êtes ici").addTo(markersLayer);
  }
}

// ---------- liste ----------
function computeResults() {
  const center = state.center || DEFAULT_CENTER;
  return state.spots
    .map((spot) => ({
      spot,
      dist: haversine(center, spot),
      res: scoreFor(spot, state.day, state.hour),
    }))
    .sort((a, b) => a.dist - b.dist);
}

function renderList(results) {
  const shown = results.filter((r) => r.dist <= 90).slice(0, 45);
  $("#spot-list").innerHTML = shown.map(({ spot, dist, res }) => {
    if (!res) return "";
    const wx = wxAt(spot, state.day, res.bestHour ?? 12);
    return `
    <div class="spot-card" data-slug="${spot.slug}">
      <div class="spot-thumb">${windRoseSVG(spot.orientations, wx?.windDir, 64, res.score, res.color)}</div>
      <div class="spot-card-main">
        <h3>${esc(spot.name)}</h3>
        <div class="meta">${spot.altitude ? spot.altitude + " m · " : ""}${Math.round(dist)} km · déco ${orientationLabel(spot.orientations)}</div>
        <div class="badges">
          ${spot.famous ? '<span class="badge">★ site majeur</span>' : ""}
          <span class="badge">${esc(spot.level_min)}</span>
          ${(spot.transport || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}
          ${spot.thermals ? '<span class="badge">thermique</span>' : ""}
          ${spot.soaring ? '<span class="badge">soaring</span>' : ""}
        </div>
      </div>
      <div class="score-chip" style="background:${res.color}">
        <div class="n">${res.score}</div>
        <span class="v">${res.verdict}</span>
        ${state.hour === "auto" && res.bestHour != null && res.score > 0 ? `<span class="h">à ${res.bestHour} h</span>` : ""}
      </div>
    </div>`;
  }).join("") || '<p class="muted">Aucun spot à moins de 90 km de ce point.</p>';
  $("#spot-list").querySelectorAll(".spot-card").forEach((el) => {
    el.onclick = () => { location.hash = `#/spot/${el.dataset.slug}`; };
  });
}

function renderStatus() {
  const when = state.fetchedAt ? new Date(state.fetchedAt) : null;
  const fmt = when ? when.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "?";
  const live = state.snapshot === "live";
  $("#wx-status").innerHTML =
    `${live ? "🟢 Prévisions en direct" : "🕓 Snapshot archivé"} — données récupérées le ${fmt} · modèle Open-Meteo (AROME/ICON)`;
}

// ---------- page spot ----------
function renderSpotPage(slug) {
  const spot = state.spots.find((s) => s.slug === slug);
  const el = $("#view-spot");
  if (!spot) { el.innerHTML = "<p>Spot introuvable. <a href='#/'>← Retour</a></p>"; return; }

  const dayRes = scoreFor(spot, state.day, "auto");
  const hour = state.hour === "auto" ? (dayRes?.bestHour ?? 12) : state.hour;
  const wx = wxAt(spot, state.day, hour);
  const res = wx ? scoreSpotHour(spot, wx, { sport: state.sport, level: state.level }) : null;
  const days = forecastDates();
  const fmtDay = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  const factorsHTML = res ? res.factors.map((f) => `
    <div class="factor ${f.gate && f.score === 0 ? "gate-fail" : ""}">
      <div class="factor-head">
        <span class="name">${esc(f.label)} ${f.gate && f.score === 0 ? '<span class="gate-tag">ÉLIMINATOIRE</span>' : ""}</span>
        <div class="factor-bar"><i style="width:${Math.round(f.score * 100)}%;background:${f.score === 0 ? "#d73027" : f.score < 0.5 ? "#f46d43" : f.score < 0.8 ? "#fdae61" : "#1a9850"}"></i></div>
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

  const explanation = res ? buildScoreNarrative(res, spot, wx) : "";

  el.innerHTML = `
    <a class="back-link" href="#/">← Retour à la liste</a>
    <div class="spot-page">
      <div class="spot-head">
        <div style="display:flex;gap:16px;align-items:flex-start">
          <div>${windRoseSVG(spot.orientations, wx?.windDir, 92, null, res?.color)}</div>
          <div>
            <h1>${esc(spot.name)}</h1>
            <div class="meta">
              Décollage ${spot.altitude ? spot.altitude + " m" : "?"} · orientation ${orientationLabel(spot.orientations)}
              ${spot.landing?.altitude != null ? ` · atterrissage ${spot.landing.altitude} m (${esc(spot.landing.name)})` : ""}<br>
              Niveau conseillé : <strong>${esc(spot.level_min)}</strong>
              ${spot.famous ? " · ★ site majeur" : ""}
            </div>
            <div class="transport-tags">
              ${(spot.transport || []).map((t) => `<span class="badge">🚗 ${esc(t)}</span>`).join("")}
            </div>
          </div>
        </div>
        ${res ? `<div class="big-score" style="background:${res.color}">
          <div class="n">${res.score}</div><span class="v">${res.verdict}</span>
          <span class="v">${fmtDay.format(days[state.day])} · ${hour} h</span>
        </div>` : ""}
      </div>

      <div class="hour-strip">${hourStrip}</div>
      <p class="muted" style="font-size:0.75rem;margin:2px 0 0">Score heure par heure — cliquez sur un créneau. ${dayRes?.bestHour != null ? `Meilleur créneau du jour : <strong>${dayRes.bestHour} h (${dayRes.score}/100)</strong>.` : ""}</p>

      <h2 class="section-title">🧮 Pourquoi ce score ?</h2>
      <p class="explain-intro">${explanation}</p>
      ${factorsHTML}
      <p class="explain-intro" style="margin-top:10px">
        Le score combine tous ces facteurs : une moyenne pondérée mesure la qualité d'ensemble, puis le
        <em>pire</em> facteur tire le score vers le bas — car en vol libre, une seule mauvaise condition suffit
        à rendre un vol dangereux. Un facteur « éliminatoire » à zéro (pluie, vent de cul, vent trop fort…)
        met directement le score à 0. <a href="#/methodo">Méthodologie complète →</a>
      </p>

      <div class="spot-grid">
        <div>
          ${spot.fr_notes ? `<div class="info-block"><h4>Le spot en bref</h4><p>${esc(spot.fr_notes)}</p></div>` : ""}
          ${spot.takeoff_description ? `<div class="info-block"><h4>Décollage</h4><p>${esc(spot.takeoff_description)}</p></div>` : ""}
          ${spot.landing?.description || spot.landing?.name ? `<div class="info-block"><h4>Atterrissage</h4><p>${esc(spot.landing.name)}${spot.landing.description ? " — " + esc(spot.landing.description) : ""}</p></div>` : ""}
          ${spot.transport_notes || spot.going_there ? `<div class="info-block"><h4>Y aller</h4><p>${esc(spot.transport_notes || spot.going_there)}</p></div>` : ""}
          ${spot.weather_notes ? `<div class="info-block"><h4>Aérologie locale (notes pilotes)</h4><p>${esc(spot.weather_notes)}</p></div>` : ""}
          ${spot.flight_rules ? `<div class="info-block"><h4>Espace aérien</h4><p>${esc(spot.flight_rules)}</p></div>` : ""}
          ${spot.comments ? `<div class="info-block"><h4>Commentaires pilotes</h4><p>${esc(spot.comments)}</p></div>` : ""}
        </div>
        <div>
          ${wx ? `<div class="info-block"><h4>Météo du créneau (${hour} h)</h4>
            <p>💨 Vent au sol : <strong>${wx.windSpeed} km/h</strong> ${fromDir(DIR_FR[dirFromDegrees(wx.windDir)])} (${wx.windDir}°)
Rafales : ${wx.windGusts} km/h
🎈 Vent à ~1500 m : ${wx.windMeta} km/h ${wx.windMetaDir != null ? fromDir(DIR_FR[dirFromDegrees(wx.windMetaDir)]) : ""}
🌡 ${wx.temp} °C · ☁️ ${wx.cloudcover} % · 🌧 ${wx.precip} mm (prob. ${wx.precipProb ?? "?"} %)
⚡ CAPE : ${Math.round(wx.cape ?? 0)} J/kg</p></div>` : ""}
          <div class="info-block"><h4>Caractéristiques</h4>
            <p>${[spot.thermals && "Site thermique", spot.soaring && "Soaring possible", spot.xc && "Départ de cross", spot.hanggliding && "Delta autorisé", spot.hike && "Marche d'approche"].filter(Boolean).join("\n") || "—"}</p>
          </div>
          ${spot.pge_link ? `<div class="info-block"><h4>Sources</h4><p><a href="${esc(spot.pge_link)}" target="_blank" rel="noopener">Fiche ParaglidingEarth ↗</a>\n<a href="https://federation.ffvl.fr/" target="_blank" rel="noopener">FFVL — balises et sites officiels ↗</a></p></div>` : ""}
        </div>
      </div>
    </div>`;

  el.querySelectorAll(".hour-cell").forEach((c) => {
    c.onclick = () => { state.hour = +c.dataset.h; renderSpotPage(slug); };
  });
}

// Résumé narratif en tête d'explication
function buildScoreNarrative(res, spot, wx) {
  const worst = [...res.factors].sort((a, b) => a.score - b.score)[0];
  const good = res.factors.filter((f) => f.score >= 0.8).length;
  if (res.score === 0) {
    const gates = res.factors.filter((f) => f.gate && f.score === 0).map((f) => f.label.toLowerCase());
    return `Le score est de 0 car au moins une condition de sécurité n'est pas remplie (${gates.join(", ")}). ` +
      `En vol libre, ces conditions sont non négociables, quel que soit le niveau du pilote. Le détail de chaque facteur est expliqué ci-dessous.`;
  }
  if (res.score >= 80) return `${good} facteurs sur ${res.factors.length} sont au vert : les conditions de ce créneau sont très favorables pour un pilote ${state.level} en ${SPORTS[state.sport].label.toLowerCase()}. Chaque facteur est détaillé ci-dessous.`;
  if (res.score >= 60) return `Les conditions sont globalement bonnes, mais le facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100) limite le score. Lisez son explication ci-dessous avant de décider.`;
  if (res.score >= 40) return `Conditions mitigées : le facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100) pèse fortement sur le score. Ce n'est pas forcément non-volable, mais cela demande de l'expérience et de la vigilance.`;
  return `Conditions défavorables, principalement à cause du facteur « ${worst.label} » (${Math.round(worst.score * 100)}/100). Mieux vaut choisir un autre créneau ou un autre site — le détail ci-dessous explique pourquoi.`;
}

// ---------- méthodologie ----------
function renderMethodoPage() {
  $("#view-spot").innerHTML = `
    <a class="back-link" href="#/">← Retour à la liste</a>
    <div class="methodo">
      <h1>Comment le score est-il calculé ?</h1>
      <p>Le score (0–100) estime si les conditions permettent de voler <strong>en sécurité</strong> sur un spot donné,
      à une heure donnée, pour un sport et un niveau de pilote donnés. Il croise les caractéristiques du site
      (orientation du décollage, altitude, réputation thermique) avec les prévisions météo horaires
      (Open-Meteo, modèles Météo-France AROME &amp; DWD ICON, maille ~1 km).</p>
      <h2>Les 8 facteurs</h2>
      <table>
        <tr><th>Facteur</th><th>Poids</th><th>Éliminatoire</th><th>Règle</th></tr>
        <tr><td>Jour / nuit</td><td>—</td><td>✅</td><td>Le vol libre se pratique de jour (VFR).</td></tr>
        <tr><td>Précipitations</td><td>2</td><td>✅</td><td>Pluie ⇒ 0 : une voile mouillée peut décrocher.</td></tr>
        <tr><td>Orientation du vent</td><td>3</td><td>✅</td><td><strong>Vent de cul ⇒ 0.</strong> Face idéale ⇒ 1 ; travers pénalisé. Vent &lt; 5 km/h : orientation peu importante.</td></tr>
        <tr><td>Force du vent</td><td>3</td><td>✅</td><td>Fenêtre idéale selon sport × niveau (ex. parapente débutant : 5–14 km/h, maxi 20).</td></tr>
        <tr><td>Rafales</td><td>2,5</td><td>✅</td><td>Écart rafales−moyen élevé = masse d'air turbulente.</td></tr>
        <tr><td>Vent d'altitude (850 hPa)</td><td>2</td><td>✅</td><td>Vent météo fort en altitude = turbulences et dérive, même si la brise au sol est douce.</td></tr>
        <tr><td>Risque orageux (CAPE)</td><td>1,5</td><td>✅</td><td>CAPE ≥ 1800 J/kg ⇒ 0 (cumulonimbus).</td></tr>
        <tr><td>Aérologie du créneau</td><td>1</td><td>—</td><td>Débutants : éviter le cœur thermique des journées d'été ; confirmés : c'est le meilleur moment.</td></tr>
      </table>
      <h2>Agrégation</h2>
      <p><code>score = 100 × moyenne pondérée × (0,4 + 0,6 × pire facteur)</code></p>
      <p>La moyenne mesure la qualité d'ensemble ; le terme « pire facteur » traduit une règle d'or du vol libre :
      <em>une seule condition mauvaise suffit à rendre un vol dangereux</em>. Les facteurs éliminatoires à zéro
      (pluie, vent de cul, vent trop fort, orage…) mettent le score à 0 directement.</p>
      <h2>Verdicts</h2>
      <p>80+ Excellent · 60+ Bon · 40+ Moyen · 20+ Défavorable · &lt;20 Ne pas voler.
      En liste, le score affiché est celui du <strong>meilleur créneau horaire</strong> de la journée choisie.</p>
      <h2>Limites</h2>
      <p>La maille du modèle (~1 km) ne résout pas les effets très locaux (brises de pente, venturis, confluences).
      Les orientations des sites sont des données communautaires (ParaglidingEarth/FFVL), parfois incomplètes.
      <strong>Petitoizo ne remplace ni les balises FFVL, ni la manche à air, ni l'avis des pilotes locaux.</strong></p>
    </div>`;
}

// ---------- recherche de ville ----------
function setupCitySearch() {
  const input = $("#city-input"), box = $("#city-suggestions");
  let t;
  input.oninput = () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.add("hidden"); return; }
    t = setTimeout(async () => {
      try {
        const res = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(q)}&fields=nom,centre,codesPostaux,population&boost=population&limit=6`);
        const cities = await res.json();
        box.innerHTML = cities.map((c) =>
          `<div data-lat="${c.centre.coordinates[1]}" data-lon="${c.centre.coordinates[0]}" data-name="${esc(c.nom)}">
            ${esc(c.nom)} <span class="muted">(${c.codesPostaux?.[0] ?? ""})</span></div>`).join("");
        box.classList.toggle("hidden", cities.length === 0);
        box.querySelectorAll("div").forEach((d) => {
          d.onclick = () => {
            state.center = { lat: +d.dataset.lat, lon: +d.dataset.lon, label: d.dataset.name };
            input.value = d.dataset.name;
            box.classList.add("hidden");
            map.setView([state.center.lat, state.center.lon], 10);
            rerender();
          };
        });
      } catch { box.classList.add("hidden"); }
    }, 250);
  };
  document.addEventListener("click", (e) => { if (!box.contains(e.target) && e.target !== input) box.classList.add("hidden"); });

  $("#btn-geoloc").onclick = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        state.center = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position" };
        input.value = "";
        map.setView([state.center.lat, state.center.lon], 10);
        rerender();
      },
      () => alert("Impossible de vous géolocaliser — cherchez une ville à la place."),
      { timeout: 8000 });
  };
}

// ---------- snapshots ----------
async function setupSnapshots() {
  try {
    const idx = await (await fetch("data/forecasts/index.json")).json();
    state.snapshotIndex = idx.snapshots || [];
  } catch { state.snapshotIndex = []; }
  const sel = $("#snapshot-select");
  const fmt = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  sel.innerHTML = `<option value="live">en direct (dernières prévisions)</option>` +
    state.snapshotIndex.map((s) => `<option value="${s.file}">archive du ${fmt(s.fetched_at)}</option>`).join("");
  sel.onchange = async () => {
    if (sel.value === "live") {
      state.snapshot = "live";
      state.forecasts = state.liveForecasts;
      state.fetchedAt = state.liveFetchedAt;
    } else {
      const snap = await (await fetch(`data/forecasts/${sel.value}`)).json();
      state.snapshot = sel.value;
      state.forecasts = snap.forecasts;
      state.fetchedAt = snap.fetched_at;
      state.day = 0;
    }
    renderDayChips();
    rerender();
  };
}

// ---------- routage ----------
function route() {
  const hash = location.hash || "#/";
  const isSpot = hash.startsWith("#/spot/");
  const isMethodo = hash.startsWith("#/methodo");
  $("#view-list").classList.toggle("hidden", isSpot || isMethodo);
  $("#view-spot").classList.toggle("hidden", !(isSpot || isMethodo));
  if (isSpot) renderSpotPage(decodeURIComponent(hash.slice(7)));
  else if (isMethodo) renderMethodoPage();
  else rerenderList();
  window.scrollTo(0, 0);
}

function rerenderList() {
  if (!state.forecasts) return;
  const results = computeResults();
  renderMap(results);
  renderList(results);
  renderStatus();
  renderDayChips();
  renderHourChips();
}

function rerender() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/spot/")) { renderDayChips(); renderHourChips(); renderSpotPage(decodeURIComponent(hash.slice(7))); }
  else rerenderList();
}

// ---------- init ----------
async function init() {
  renderPrefs();
  initMap();
  setupCitySearch();

  const spotsData = await (await fetch("data/spots.json")).json();
  state.spots = spotsData.spots;

  // 1. snapshot embarqué (affichage immédiat), 2. rafraîchissement live en arrière-plan
  try {
    const snap = await (await fetch("data/forecasts/latest.json")).json();
    state.forecasts = snap.forecasts;
    state.fetchedAt = snap.fetched_at;
    state.liveForecasts = snap.forecasts;
    state.liveFetchedAt = snap.fetched_at;
  } catch { /* pas de snapshot embarqué */ }
  route();

  setupSnapshots();

  try {
    $("#wx-status").innerHTML = "⏳ Récupération des dernières prévisions…";
    const live = await fetchLiveForecasts(state.spots);
    state.liveForecasts = live;
    state.liveFetchedAt = new Date().toISOString();
    if (state.snapshot === "live") {
      state.forecasts = live;
      state.fetchedAt = state.liveFetchedAt;
      rerender();
    }
  } catch (e) {
    console.warn("Live Open-Meteo indisponible, snapshot conservé", e);
    renderStatus();
  }

  window.addEventListener("hashchange", route);
}

init();
