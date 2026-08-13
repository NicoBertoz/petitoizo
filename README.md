# 🪂 Petitoizo

**Où aller voler en sécurité, selon les conditions.**
→ Live : **https://nicobertoz.github.io/petitoizo/**

Petitoizo aide les pratiquants de vol libre (parapente par défaut, speed-riding, delta) à
choisir **où** et **quand** voler autour de Grenoble & Chambéry : géolocalisation ou
recherche de ville, choix du jour et du créneau horaire, carte + liste des spots proches
avec un **score de volabilité 0–100**, et une page par spot qui **explique pédagogiquement
chaque facteur du score**.

## Architecture

Site 100 % statique — aucune base de données ni backend à maintenir.

```
public/
  index.html, app.js, styles.css   ← SPA (vanilla JS + Leaflet)
  scoring.js                       ← moteur de score, partagé navigateur/Node
  data/spots.json                  ← base des spots (générée)
  data/forecasts/                  ← snapshots météo horodatés + latest.json + index.json
scripts/
  build-spots.js                   ← ParaglidingEarth/FFVL + data/curated.json → spots.json
  fetch-forecast.js                ← Open-Meteo 8 jours → snapshot horodaté
data/
  raw/                             ← exports ParaglidingEarth bruts
  curated.json                     ← enrichissement manuel (accès, niveau, notes FR)
  extra-spots.json                 ← spots absents de la source (ex : Challes-les-Eaux)
```

- **Spots** : ParaglidingEarth (données communautaires, largement FFVL) — 113 spots dans
  un rayon de ~55 km autour de Grenoble et Chambéry, enrichis à la main pour les sites
  majeurs (transports, niveau requis, notes en français).
- **Météo** : [Open-Meteo](https://open-meteo.com) (AROME/ARPEGE/ICON, maille ~1 km),
  gratuit et sans clé. Le navigateur récupère les prévisions **en direct** à chaque visite ;
  les snapshots archivés permettent de **rejouer d'anciennes prévisions** (sélecteur en
  pied de page).
- **Rafraîchissement** : GitHub Actions ([refresh-forecasts.yml](.github/workflows/refresh-forecasts.yml))
  récupère un snapshot toutes les 6 h et republie le site.
- **Score** : voir [METHODOLOGY.md](METHODOLOGY.md) — orientation du vent vs décollage
  (vent de cul ⇒ 0), force du vent et rafales selon sport × niveau, vent d'altitude
  (850 hPa), pluie, CAPE, aérologie du créneau.

## Développement

```bash
npm run build:spots      # régénère public/data/spots.json
npm run fetch:forecast   # nouveau snapshot météo
npm run serve            # sert public/ en local
```

Déploiement : pousser sur `gh-pages` (le workflow s'en charge).

## ⚠️ Avertissement

Petitoizo est une **aide à la décision**, pas une autorisation de vol. Consultez toujours
les balises FFVL, la manche à air et les pilotes locaux. L'auteur décline toute
responsabilité en cas d'incident.
