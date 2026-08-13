// Petitoizo — moteur de score de volabilité.
// Module partagé navigateur / Node. Voir METHODOLOGY.md pour la méthodologie complète.

export const SPORTS = {
  parapente: {
    label: "Parapente",
    // fenêtres de vent au sol (km/h) par niveau : [mini idéal, début idéal, fin idéal, maxi absolu]
    wind: {
      "débutant": [0, 5, 14, 20],
      "intermédiaire": [0, 5, 18, 25],
      "confirmé": [0, 6, 22, 30],
      "expert": [0, 6, 25, 35],
    },
    // écart rafales - vent moyen toléré (km/h) : [début pénalité, rédhibitoire]
    gust: { "débutant": [6, 14], "intermédiaire": [8, 17], "confirmé": [10, 20], "expert": [12, 24] },
    // vent météo à ~1500 m (850 hPa) : [début pénalité, rédhibitoire]
    meta: { "débutant": [20, 30], "intermédiaire": [25, 38], "confirmé": [30, 45], "expert": [35, 55] },
  },
  speedriding: {
    label: "Speed-riding / mini-voile",
    wind: {
      "débutant": [0, 8, 22, 30],
      "intermédiaire": [0, 8, 28, 38],
      "confirmé": [0, 10, 32, 45],
      "expert": [0, 10, 38, 55],
    },
    gust: { "débutant": [10, 18], "intermédiaire": [12, 22], "confirmé": [14, 26], "expert": [16, 30] },
    meta: { "débutant": [30, 42], "intermédiaire": [35, 50], "confirmé": [40, 58], "expert": [45, 65] },
  },
  delta: {
    label: "Deltaplane",
    wind: {
      "débutant": [0, 8, 20, 28],
      "intermédiaire": [0, 8, 25, 35],
      "confirmé": [0, 10, 30, 42],
      "expert": [0, 10, 34, 50],
    },
    gust: { "débutant": [8, 16], "intermédiaire": [10, 20], "confirmé": [12, 24], "expert": [14, 28] },
    meta: { "débutant": [25, 38], "intermédiaire": [30, 45], "confirmé": [35, 52], "expert": [40, 60] },
  },
};

export const LEVELS = ["débutant", "intermédiaire", "confirmé", "expert"];

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const DIR_FR = {
  N: "Nord", NE: "Nord-Est", E: "Est", SE: "Sud-Est",
  S: "Sud", SW: "Sud-Ouest", W: "Ouest", NW: "Nord-Ouest",
};

// "du Nord", "de l'Est", "du Sud-Ouest"…
export const fromDir = (name) => (name === "Est" || name === "Ouest" ? `de l'${name}` : `du ${name}`);

export function dirFromDegrees(deg) {
  return DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// Meilleure orientation du site (secteur le mieux noté)
export function bestOrientations(orientations) {
  const max = Math.max(...DIRS.map((d) => orientations[d] || 0));
  if (max === 0) return [];
  return DIRS.filter((d) => (orientations[d] || 0) === max);
}

export function orientationLabel(orientations) {
  const good = DIRS.filter((d) => (orientations[d] || 0) >= 1);
  if (!good.length) return "non renseignée";
  return good.map((d) => DIR_FR[d]).join(", ");
}

const angleDiff = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Fonction trapèze : 1 dans [b,c], monte de a→b, descend de c→d, 0 au-delà.
const trapezoid = (x, [a, b, c, d]) => {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a || 1);
  if (x <= c) return 1;
  return (d - x) / (d - c || 1);
};

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Calcule le score de volabilité pour un spot à une heure donnée.
 * @param spot   {orientations, thermals, altitude, ...}
 * @param wx     {windSpeed, windDir, windGusts, windMeta, windMetaDir, precip,
 *                precipProb, cloudcover, cape, temp, isDay, hour, month}
 *               vitesses en km/h, directions en ° (vent venant de), precip en mm/h
 * @param opts   {sport: "parapente", level: "intermédiaire"}
 * @returns {score: 0-100, verdict, color, factors: [{key,label,score,weight,gate,detail}]}
 */
export function scoreSpotHour(spot, wx, opts = {}) {
  const sport = SPORTS[opts.sport || "parapente"];
  const level = opts.level || "intermédiaire";
  const factors = [];
  const windDirName = DIR_FR[dirFromDegrees(wx.windDir)];

  // ---- 1. Nuit ----
  if (wx.isDay === 0) {
    return {
      score: 0, verdict: "Nuit", color: "#64748b", emoji: "🌙",
      factors: [{ key: "night", label: "Jour / nuit", score: 0, weight: 1, gate: true,
        detail: "Il fait nuit à cette heure : le vol libre se pratique de jour (règles VFR)." }],
    };
  }

  // ---- 2. Pluie (facteur éliminatoire) ----
  {
    let s = 1, detail;
    if (wx.precip >= 0.5) {
      s = 0;
      detail = `Pluie prévue (${r1(wx.precip)} mm/h) : une voile mouillée perd ses qualités de vol et risque le décrochage — on ne vole pas sous la pluie.`;
    } else if (wx.precip > 0.05 || (wx.precipProb ?? 0) >= 60) {
      s = 0.25;
      detail = `Risque d'averses (${wx.precipProb ?? "?"} % de probabilité) : à surveiller sur place, une voile mouillée est dangereuse.`;
    } else if ((wx.precipProb ?? 0) >= 35) {
      s = 0.7;
      detail = `Faible risque de précipitations (${wx.precipProb} %) : ciel à surveiller.`;
    } else {
      detail = "Pas de pluie prévue : condition remplie.";
    }
    factors.push({ key: "rain", label: "Précipitations", score: s, weight: 2, gate: s === 0, detail });
  }

  // ---- 3. Orientation du vent vs décollage ----
  {
    const windLight = wx.windSpeed < 5;
    const sector = dirFromDegrees(wx.windDir);
    const rating = spot.orientations?.[sector] ?? 0;
    const best = bestOrientations(spot.orientations || {});
    let s, detail;
    if (!best.length) {
      s = 0.6;
      detail = "Orientation du décollage non renseignée : impossible de vérifier l'alignement du vent — prudence.";
    } else if (windLight) {
      s = 0.9;
      detail = `Vent très faible (${r1(wx.windSpeed)} km/h) : l'orientation du décollage importe peu, décollage en course possible.`;
    } else if (rating === 2) {
      s = 1;
      detail = `Le vent vient ${fromDir(windDirName)}, pile dans l'axe du décollage (orienté ${orientationLabel(spot.orientations)}) : vent de face idéal pour gonfler la voile.`;
    } else if (rating === 1) {
      s = 0.7;
      detail = `Le vent ${fromDir(windDirName)} arrive de travers par rapport à l'orientation idéale (${best.map((d) => DIR_FR[d]).join("/")}) : décollage possible mais moins confortable.`;
    } else {
      // le secteur du vent est noté 0 : travers fort ou vent de cul ?
      const bestDeg = DIRS.indexOf(best[0]) * 45;
      const diff = angleDiff(wx.windDir, bestDeg);
      if (diff >= 120) {
        s = 0;
        detail = `Le vent vient ${fromDir(windDirName)} alors que le décollage est orienté ${best.map((d) => DIR_FR[d]).join("/")} : c'est du vent de cul (arrière). Décoller dos au vent est impossible en sécurité, et l'écoulement sous le vent du relief crée des turbulences dangereuses.`;
      } else {
        s = 0.25;
        detail = `Le vent ${fromDir(windDirName)} est très en travers de l'axe du décollage (${best.map((d) => DIR_FR[d]).join("/")}) : gonflage difficile et aérologie perturbée sur ce versant.`;
      }
    }
    factors.push({ key: "orientation", label: "Orientation du vent", score: s, weight: 3, gate: s === 0, detail });
  }

  // ---- 4. Force du vent au sol ----
  {
    const w = sport.wind[level];
    const s = trapezoid(wx.windSpeed, w);
    let detail;
    if (wx.windSpeed > w[3]) {
      detail = `${r1(wx.windSpeed)} km/h de vent moyen : au-delà du maximum de sécurité (${w[3]} km/h) pour un pilote ${level} en ${sport.label.toLowerCase()}. Risque de reculer en l'air ou de ne pas pouvoir contrôler la voile au sol.`;
    } else if (s === 1) {
      detail = `${r1(wx.windSpeed)} km/h : force de vent idéale pour un pilote ${level} (fenêtre confortable : ${w[1]}–${w[2]} km/h).`;
    } else if (wx.windSpeed > w[2]) {
      detail = `${r1(wx.windSpeed)} km/h : vent soutenu, en haut de la fenêtre recommandée pour un pilote ${level} (${w[1]}–${w[2]} km/h). Pilotage plus exigeant.`;
    } else {
      detail = `${r1(wx.windSpeed)} km/h : vent faible, décollage en course et vol plouf probable (peu de portance dynamique).`;
    }
    factors.push({ key: "wind", label: "Force du vent", score: s, weight: 3, gate: s === 0, detail });
  }

  // ---- 5. Rafales ----
  {
    const [warn, max] = sport.gust[level];
    const delta = Math.max(0, (wx.windGusts ?? wx.windSpeed) - wx.windSpeed);
    const s = 1 - clamp01((delta - warn) / (max - warn));
    let detail;
    if (delta >= max) {
      detail = `Rafales à ${r1(wx.windGusts)} km/h, soit ${r1(delta)} km/h au-dessus du vent moyen : un écart pareil signale une masse d'air très turbulente (risque de fermetures de voile près du relief).`;
    } else if (s < 1) {
      detail = `Écart rafales/vent moyen de ${r1(delta)} km/h (${r1(wx.windSpeed)} → ${r1(wx.windGusts)} km/h) : de la turbulence est à prévoir, restez attentif.`;
    } else {
      detail = `Vent régulier (rafales à ${r1(wx.windGusts ?? wx.windSpeed)} km/h pour ${r1(wx.windSpeed)} km/h de moyenne) : masse d'air homogène, condition remplie.`;
    }
    factors.push({ key: "gusts", label: "Rafales", score: s, weight: 2.5, gate: s === 0, detail });
  }

  // ---- 6. Vent météo en altitude (~1500 m / 850 hPa) ----
  if (wx.windMeta != null) {
    const [warn, max] = sport.meta[level];
    const s = 1 - clamp01((wx.windMeta - warn) / (max - warn));
    const metaDirName = wx.windMetaDir != null ? DIR_FR[dirFromDegrees(wx.windMetaDir)] : null;
    let detail;
    if (s === 0) {
      detail = `Vent météo de ${r1(wx.windMeta)} km/h${metaDirName ? ` ${fromDir(metaDirName)}` : ""} vers 1 500 m : trop fort. Même si la brise en vallée semble gérable, un vent d'altitude pareil crée des turbulences sous le vent des reliefs et un fort risque de dérive arrière.`;
    } else if (s < 1) {
      detail = `Vent météo de ${r1(wx.windMeta)} km/h${metaDirName ? ` ${fromDir(metaDirName)}` : ""} vers 1 500 m : sensible en altitude. Le seuil de vigilance pour un pilote ${level} est ${warn} km/h — gardez de la marge par rapport au relief.`;
    } else {
      detail = `Vent météo faible en altitude (${r1(wx.windMeta)} km/h vers 1 500 m) : pas de sur-vitesse à craindre en prenant de la hauteur.`;
    }
    factors.push({ key: "meta", label: "Vent d'altitude", score: s, weight: 2, gate: s === 0, detail });
  }

  // ---- 7. Instabilité orageuse (CAPE) ----
  if (wx.cape != null) {
    let s = 1, detail;
    if (wx.cape >= 1800) {
      s = 0;
      detail = `CAPE de ${Math.round(wx.cape)} J/kg : atmosphère très instable, risque orageux marqué. Un cumulonimbus aspire tout ce qui vole — on reste au sol.`;
    } else if (wx.cape >= 1000) {
      s = 0.4;
      detail = `CAPE de ${Math.round(wx.cape)} J/kg : instabilité notable, développements orageux possibles dans l'après-midi. Voler tôt et surveiller les congestus.`;
    } else if (wx.cape >= 500) {
      s = 0.8;
      detail = `CAPE de ${Math.round(wx.cape)} J/kg : instabilité modérée — bons thermiques probables, surveiller l'évolution du ciel.`;
    } else {
      detail = `Atmosphère stable (CAPE ${Math.round(wx.cape)} J/kg) : pas de risque orageux.`;
    }
    factors.push({ key: "cape", label: "Risque orageux", score: s, weight: 1.5, gate: s === 0, detail });
  }

  // ---- 8. Aérologie thermique selon l'heure et le niveau ----
  {
    const h = wx.hour;
    const midday = h >= 12 && h <= 16;
    const edges = h <= 10 || h >= 18;
    const summer = wx.month >= 5 && wx.month <= 9;
    let s = 1, detail;
    if (level === "débutant" && midday && summer && (wx.cloudcover ?? 100) < 70) {
      s = 0.45;
      detail = `À ${h} h en été, les thermiques sont les plus puissants et l'aérologie la plus turbulente de la journée : pour un pilote débutant, privilégiez le matin (avant 11 h) ou la fin de journée (après 17 h), quand la masse d'air se calme.`;
    } else if (level === "débutant" && edges) {
      detail = `Créneau du ${h < 12 ? "matin" : "soir"} : aérologie calme et laminaire, idéale pour un pilote débutant.`;
    } else if ((level === "confirmé" || level === "expert") && midday && spot.thermals && (wx.cloudcover ?? 100) < 60) {
      s = 1;
      detail = `Cœur de journée avec du soleil sur un site thermique réputé : le meilleur créneau pour exploiter les ascendances${spot.xc ? " et partir en cross" : ""}.`;
    } else if ((wx.cloudcover ?? 0) > 85) {
      s = 0.85;
      detail = `Ciel très couvert (${Math.round(wx.cloudcover)} % de nuages) : peu ou pas de thermiques, vol calme mais sans ascendances.`;
    } else {
      detail = `Créneau horaire sans particularité aérologique pour un pilote ${level}.`;
    }
    factors.push({ key: "thermal", label: "Aérologie du créneau", score: s, weight: 1, gate: false, detail });
  }

  // ---- Agrégation ----
  // Les facteurs "gate" à 0 rendent le score nul (conditions éliminatoires).
  const gated = factors.some((f) => f.gate && f.score === 0);
  let score;
  if (gated) score = 0;
  else {
    const wsum = factors.reduce((a, f) => a + f.weight, 0);
    const mean = factors.reduce((a, f) => a + f.score * f.weight, 0) / wsum;
    // pénalisation par le pire facteur (une seule condition mauvaise suffit à gâcher un vol)
    const worst = Math.min(...factors.map((f) => f.score));
    score = Math.round(100 * mean * (0.4 + 0.6 * worst));
  }

  const bands = [
    [80, "Excellent", "#10b981", "🤩"],
    [60, "Bon", "#84cc16", "😀"],
    [40, "Moyen", "#fbbf24", "😐"],
    [20, "Défavorable", "#fb923c", "😕"],
    [0, "Ne pas voler", "#ef4444", "🚫"],
  ];
  const [, verdict, color, emoji] = bands.find(([t]) => score >= t);
  return { score, verdict, color, emoji, factors };
}

/**
 * Meilleur créneau du jour : max des scores horaires (heures de jour).
 * hours: [{...wx}] — renvoie {score, verdict, color, bestHour, hourly:[{hour,score,verdict,color}]}
 */
export function scoreSpotDay(spot, hours, opts) {
  let best = null;
  const hourly = hours.map((wx) => {
    const r = scoreSpotHour(spot, wx, opts);
    if (!best || r.score > best.score) best = { ...r, hour: wx.hour };
    return { hour: wx.hour, score: r.score, verdict: r.verdict, color: r.color };
  });
  return { ...(best || { score: 0, verdict: "Ne pas voler", color: "#ef4444", emoji: "🚫", hour: null }), bestHour: best?.hour ?? null, hourly };
}
