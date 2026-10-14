# TransPanda

Site de transports en Nouvelle-Aquitaine : tableaux d’horaires par arrêt ou ligne, carte des arrêts, recherche d’adresses, itinéraires avec correspondances et positions récentes des véhicules TBM.

Le site est hébergé sur [Cloudflare Workers](https://transpanda.tomikofauveau.workers.dev/). [CLOUDFLARE.md](CLOUDFLARE.md) décrit le déploiement. Les sources utilisées sont publiques ; aucune clé personnelle data.gouv.fr ou Navitia n’est nécessaire.

## Développement et tests

Node.js 22.15 ou plus récent et Python 3 avec SQLite sont nécessaires. Depuis le checkout existant :

```sh
npm ci
npm test
npm run build
npm run dev
```

Le build télécharge le GTFS publié par PIGMA, l’importe dans une base temporaire et prépare `public/`. `npm run dev` démarre le site et ses API dans le runtime local Cloudflare. Le serveur de développement utilise le proxy réseau et les certificats de confiance de l’environnement pour les fournisseurs IGN et TBM ; la vérification TLS reste active. Redémarrer le serveur après une modification du Worker ou des fichiers source. Le port par défaut est 8001, modifiable avec `TRANSPANDA_DEV_PORT`. Pour réutiliser une base GTFS déjà importée :

```sh
TRANSPANDA_GTFS_DB=/workspace/transpanda-data/gtfs.sqlite npm run build
```

`python3 server.py --port 8000` reste disponible pour les horaires, les fichiers générés et le calcul des trajets. Les API d’adresses et de positions sont fournies par le Worker : utiliser `npm run dev` pour ces fonctions. Les fichiers ZIP, SQLite, `public/`, `node_modules/` et `.wrangler/` sont exclus du dépôt.

## Adresses et trajets

Le panneau « Calculer un itinéraire » propose les adresses du service gratuit de géocodage IGN. Le Worker appelle un fournisseur fixe, valide les coordonnées et met les réponses en cache cinq minutes. En cas d’indisponibilité, l’interface propose des arrêts publiés du GTFS. Un lieu doit être choisi dans les suggestions avant la recherche ; un texte libre n’est pas converti en coordonnées inventées.

Le moteur utilise les courses complètes et leur ordre d’arrêts, les horaires d’arrivée et de départ, les calendriers et les exceptions du GTFS. Il cherche d’abord les trajets directs, puis ceux à une et deux correspondances. Il privilégie le nombre de correspondances et l’arrivée la plus tôt dans ce groupe ; un trajet avec davantage de correspondances peut être plus rapide. Les montées/descentes interdites ou soumises à réservation sont exclues. Les services au-delà de minuit et les horaires des jours voisins sont pris en compte.

L’accès à pied aux arrêts est limité à un kilomètre, les correspondances à pied à 250 mètres et leur marge minimale à deux minutes. Les distances et durées de marche sont estimées à vol d’oiseau : aucun chemin piéton, accès sécurisé ou accessibilité n’est garanti. La recherche couvre les 24 heures suivant l’heure choisie, selon les données disponibles. Ses limites de volume sont indiquées sans présenter une recherche interrompue comme une absence de trajet. Les fichiers des lignes nécessaires sont chargés progressivement ; leur date d’import est vérifiée pour éviter de mélanger des versions de données.

« Voir sur la carte » montre les étapes et un tracé indicatif entre elles, qui ne suit pas les rues ou les voies réelles. Les horaires du calcul restent prévus : les positions TBM ne servent pas à inventer des retards.

## Carte et temps réel

« Ouvrir la carte » affiche automatiquement les arrêts proches de Bordeaux. Déplacer la carte affiche les repères de la zone visible ; cliquer sur un groupe numéroté zoome vers ses quais. Une recherche d’arrêt ou de ligne recentre sur ses résultats ; « Tous les arrêts » rétablit l’exploration. « Voir les horaires » sélectionne le quai et ouvre son tableau.

« Afficher les véhicules TBM » active les positions officielles de Bordeaux Métropole, avec des repères orange. Les requêtes ont lieu toutes les 30 secondes tant que l’option est active et la page visible. Les positions de plus de cinq minutes, les dates incohérentes et les coordonnées invalides ne sont pas affichées. Les erreurs et l’absence de positions récentes sont distinguées. Le Worker décode le GTFS-Realtime et partage un cache de 30 secondes. Aucun véhicule fictif ne remplace une donnée indisponible.

Leaflet 1.9.4 est fourni localement avec sa licence MIT. Le fond OpenStreetMap est chargé à l’ouverture, avec attribution visible. Si les tuiles sont indisponibles, les repères restent consultables.

## Sources et couverture

- Horaires, arrêts et courses : [Nouvelle-Aquitaine Mobilités via PIGMA](https://www.pigma.org/public/opendata/nouvelle_aquitaine_mobilites/publication/naq-aggregated-gtfs.zip).
- Adresses : [géocodage IGN](https://data.geopf.fr/geocodage/search).
- Positions TBM : [jeu officiel sur transport.data.gouv.fr](https://transport.data.gouv.fr/datasets/offres-de-services-bus-tram-et-scolaire-au-format-gtfs-netex-gtfs-rt-siri-lite), licence ouverte. La clé partagée publiée dans ce jeu est distincte d’un token personnel.

La couverture des horaires reste celle du GTFS de Nouvelle-Aquitaine. Le temps réel couvre actuellement TBM ; les autres réseaux conservent leurs horaires prévus. L’extension à la France se fera par ajout de sources validées.

Le build vérifie les limites gratuites Cloudflare : au plus 20 000 fichiers et 25 MiB par fichier. Les exports de routage sont répartis par ligne. La base source est ouverte en lecture seule ; les données brutes ne sont pas publiées.

Les anciens itinéraires fictifs restent dans une section de démonstration repliée et explicitement identifiée. Leurs favoris sont des exemples locaux au navigateur. Les configurations Firebase historiques ne sont pas utilisées.

## GitHub Pages

Le workflow publie les horaires et les données d’itinéraires à chaque push sur `main` et chaque jour. Pages n’exécute pas le Worker : la sélection des arrêts et les calculs fonctionnent, tandis que les adresses se rabattent sur les arrêts publiés et que les positions en temps réel nécessitent l’hébergement Workers.
