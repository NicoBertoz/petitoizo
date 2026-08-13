# Petitoizo - Méthodologie du score de volabilité

Le score (0 à 100) estime, **pour un spot, une heure, un sport et un niveau de pilote donnés**,
si les conditions permettent de voler en sécurité. Il est calculé par
[`public/scoring.js`](public/scoring.js), le même code tournant côté serveur (snapshots) et
côté navigateur (données météo fraîches).

## 1. Données d'entrée

| Donnée | Source | Usage |
|---|---|---|
| Orientations du décollage (8 secteurs, notés 0-2) | ParaglidingEarth / FFVL | Alignement du vent |
| Vent moyen & direction à 10 m | Open-Meteo (maille ~1 km, modèles Météo-France AROME/ARPEGE + ICON) | Force & orientation |
| Rafales à 10 m | Open-Meteo | Turbulence de la masse d'air |
| Vent & direction à 850 hPa (~1 500 m) | Open-Meteo | « Vent météo » en altitude |
| Précipitations & probabilité | Open-Meteo | Facteur éliminatoire |
| Couverture nuageuse | Open-Meteo | Qualité thermique |
| CAPE | Open-Meteo | Risque orageux |
| Jour/nuit | Open-Meteo | Vol de jour uniquement |

## 2. Facteurs, poids et « portes »

Chaque facteur produit une note entre 0 et 1. Certains sont **éliminatoires** (« gate ») :
s'ils tombent à 0, le score global est 0, quelle que soit la qualité du reste.

| Facteur | Poids | Éliminatoire ? | Règle |
|---|---|---|---|
| Nuit | - | ✅ | Pas de vol de nuit (VFR). |
| Précipitations | 2 | ✅ | Pluie ⇒ 0. Probabilité ≥ 60 % ⇒ forte pénalité. |
| Orientation du vent | 3 | ✅ | **Vent de cul (écart ≥ 120° avec l'axe du déco) ⇒ 0.** Secteur idéal ⇒ 1 ; travers ⇒ 0,25-0,7. Vent < 5 km/h ⇒ l'orientation compte peu (0,9). |
| Force du vent | 3 | ✅ | Trapèze sur la fenêtre du couple sport × niveau (voir §3). Au-delà du maxi ⇒ 0. |
| Rafales | 2,5 | ✅ | Écart rafales − moyen au-delà du seuil du niveau ⇒ 0 (masse d'air turbulente). |
| Vent d'altitude (850 hPa) | 2 | ✅ | Trop de vent météo ⇒ 0 même si la brise au sol est douce (turbulences sous le vent, dérive arrière). |
| Risque orageux (CAPE) | 1,5 | ✅ | CAPE ≥ 1 800 J/kg ⇒ 0. ≥ 1 000 ⇒ 0,4. |
| Aérologie du créneau | 1 | - | Débutant : pénalité au cœur des journées thermiques d'été, bonus matin/soir. Confirmé+ : bonus mi-journée sur site thermique. |

### Agrégation

```
score = 100 × moyenne_pondérée(facteurs) × (0,4 + 0,6 × pire_facteur)
```

La moyenne pondérée mesure la qualité d'ensemble ; le terme `pire_facteur` traduit une réalité
du vol libre : **une seule condition mauvaise suffit à rendre un vol dangereux**, même si tout
le reste est parfait.

### Verdicts

| Score | Verdict |
|---|---|
| 80-100 | Excellent |
| 60-79 | Bon |
| 40-59 | Moyen |
| 20-39 | Défavorable |
| 0-19 | Ne pas voler |

Le score « du jour » affiché en liste est le **meilleur score horaire de la journée** (les
parapentistes raisonnent en créneaux : une bonne fenêtre de 2 h suffit).

## 3. Fenêtres de vent par sport et niveau (km/h au sol)

Trapèze `[mini, début idéal, fin idéal, maxi absolu]` :

| Sport | Débutant | Intermédiaire | Confirmé | Expert |
|---|---|---|---|---|
| Parapente | 0-5-14-**20** | 0-5-18-**25** | 0-6-22-**30** | 0-6-25-**35** |
| Speed-riding | 0-8-22-**30** | 0-8-28-**38** | 0-10-32-**45** | 0-10-38-**55** |
| Deltaplane | 0-8-20-**28** | 0-8-25-**35** | 0-10-30-**42** | 0-10-34-**50** |

Les seuils de rafales et de vent d'altitude suivent la même logique (voir `SPORTS` dans
`scoring.js`).

## 4. Limites connues

- La météo est issue d'un modèle à maille ~1 km : les effets très locaux (brises de pente,
  venturis, confluences) ne sont pas résolus. **Le score ne remplace jamais l'observation des
  balises FFVL, des manches à air et l'avis des pilotes locaux.**
- Les orientations de décollage sont des données communautaires ; quelques sites sont
  incomplets (traités avec une note de prudence).
- Le vent de cul est détecté par rapport au *meilleur* secteur du site ; les sites à
  décollages multiples opposés sont naturellement favorisés.

## 5. Historique des prévisions

Chaque exécution de `npm run fetch:forecast` enregistre un **snapshot horodaté** dans
`public/data/forecasts/`, référencé dans `index.json`. L'interface permet de rejouer un
snapshot passé pour comparer « ce qui était prévu » à « ce qui a été observé ».
