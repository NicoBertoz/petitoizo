# 🪂 Petitoizo

**Perché tout là-haut : où et quand voler, partout en France.**
→ Live : **https://nicobertoz.github.io/petitoizo/**

Petitoizo aide les pratiquants de vol libre (parapente par défaut, speed-riding, delta) à
choisir **où** et **quand** voler : géolocalisation ou recherche de ville, choix du jour et
du créneau horaire, carte + liste des spots proches avec un **score de volabilité 0-100**,
et une page par spot qui **explique pédagogiquement chaque facteur du score**.

**1 286 spots en France**, issus de deux sources fusionnées et recoupées.

## Architecture

Site 100 % statique - aucune base de données ni backend à maintenir.

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

- **Spots** : fusion de **ParaglidingEarth** (1 081 décollages, descriptions et accès) et
  **OpenStreetMap** (858 décollages + 641 atterrissages, dont l'import FFVL avec les fiches
  officielles, clubs et orientations). 654 spots sont présents dans les deux bases et se
  recoupent, 647 ont une fiche FFVL, 86 % ont une orientation de décollage connue. Les sites
  majeurs sont enrichis à la main (transports, niveau, notes en français).
- **Météo** : [Open-Meteo](https://open-meteo.com), gratuit et sans clé, qui agrège AROME 1 km
  (Météo-France) puis ARPEGE puis ICON/ECMWF selon l'échéance. Chaque interrogation passe
  **l'altitude réelle du décollage** pour corriger le relief lissé du modèle. Variables
  spécifiques vol libre : plafond de la couche convective, iso 0 °C, vent à 850 et 700 hPa,
  CAPE, rafales, nébulosité basse.
- **Météo-Parapente** : chaque fiche de spot contient un lien direct vers
  [meteo-parapente.com](https://meteo-parapente.com) (modèle WRF 1,2 km) sur le bon point,
  au bon jour et à la bonne heure - c'est la référence pour l'analyse fine (émagramme).
- **Rafraîchissement** : GitHub Actions ([refresh-forecasts.yml](.github/workflows/refresh-forecasts.yml))
  **toutes les heures**. Le navigateur complète en direct pour les spots affichés, donc les
  données à l'écran ont toujours quelques secondes. Archives toutes les 6 h (jeu de
  référence, purgées à 7 jours) pour rejouer d'anciennes prévisions.
- **Poids du dépôt** : gh-pages est une branche orpheline reconstruite et poussée en force
  à chaque publication, sinon 24 publications/jour feraient grossir l'historique sans fin.
- **Score** : voir [METHODOLOGY.md](METHODOLOGY.md) - orientation du vent vs décollage
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
