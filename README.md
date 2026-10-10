# TransPanda

Prototype de recherche d’itinéraires de transports en commun en Nouvelle-Aquitaine. Interface responsive en français, filtres train/tram/bus, inversion des villes, date et heure, détail des étapes et favoris enregistrés dans le navigateur.

## Développement

Aucune dépendance à installer. Depuis `/workspace/TransPanda` :

```sh
python3 server.py --port 8000
```

Le serveur Python fournit le site et une API locale de consultation des horaires GTFS. Les polices Google sont facultatives, avec polices locales de remplacement. Un hébergement statique seul ne permet pas d’utiliser les horaires importés.

## Horaires publiés

La recherche par ligne accepte un numéro, un nom ou un réseau. Choisir une ligne propose ses quais, classés par nom (tous sens et variantes confondus). Après sélection du quai et de la date, le tableau affiche uniquement les départs de cette ligne. Les numéros identiques sont distingués par le nom du réseau. La recherche de lignes est limitée à 60 résultats ; les correspondances exactes du numéro sont proposées en premier.

### GitHub Pages

Le workflow `.github/workflows/pages.yml` télécharge le GTFS, l’importe et exporte des fichiers JSON compacts par quai. Il déploie le site et ces données sur GitHub Pages à chaque push sur `main` et chaque jour. Dans le dépôt GitHub, ouvrir **Settings → Pages → Source → GitHub Actions**. Le premier déploiement doit terminer avant que les horaires fonctionnent. Aucun serveur Python n’est exécuté par Pages : les calendriers sont appliqués dans le navigateur et seul le fichier du quai choisi est chargé.

Pour tester ce mode localement :

```sh
python3 tools/export_static.py /workspace/transpanda-data/gtfs.sqlite public/data
cp index.html public/
mkdir -p public/assets
cp assets/*.js assets/*.css public/assets/
python3 -m http.server 8003 --directory public
```

Le navigateur utilise automatiquement les fichiers statiques lorsque l’API Python est absente. Le dossier généré `public/` est exclu du dépôt Git. Le workflow renouvelle les données ; une erreur de téléchargement bloque le nouveau déploiement et laisse la dernière publication disponible.

Le panneau « Les horaires à votre arrêt » utilise le GTFS agrégé de Nouvelle-Aquitaine Mobilités, téléchargé depuis PIGMA. Il affiche les départs prévus d’un quai, selon la date, les calendriers hebdomadaires et leurs exceptions. Ce ne sont pas des données de retard en temps réel. Les heures sont celles de France, y compris les services GTFS qui dépassent minuit. La recherche est limitée à 40 quais et les résultats à 30 départs jusqu’à la fin du jour choisi. Les dates hors calendrier peuvent ne produire aucun résultat.

La base est conservée hors du dépôt dans `/workspace/transpanda-data/gtfs.sqlite`. Pour la préparer ou actualiser les données :

```sh
mkdir -p /workspace/transpanda-data
curl --fail --location --show-error --output /workspace/transpanda-data/naq-aggregated-gtfs.zip https://www.pigma.org/public/opendata/nouvelle_aquitaine_mobilites/publication/naq-aggregated-gtfs.zip
python3 tools/import_gtfs.py /workspace/transpanda-data/naq-aggregated-gtfs.zip /workspace/transpanda-data/gtfs.sqlite
```

L’import crée une nouvelle base puis remplace l’ancienne après contrôle d’intégrité. Redémarrer le serveur après actualisation pour vider le cache des calendriers. Ne pas publier l’archive ni la base dans Git. Pour héberger les données et automatiser les mises à jour, vérifier la licence et les conditions de réutilisation du jeu de données.

## Limites

Le panneau « Itinéraires démo », sa carte et ses favoris restent fictifs et distincts des horaires publiés. La carte est un schéma, sans précision géographique. Aucun calcul d’itinéraire réel, tarif, information de perturbation ou suivi en temps réel n’est connecté. Les exemples couvrent Bordeaux vers La Rochelle, Poitiers, Limoges et Pau, ainsi que deux trajets urbains ; les autres recherches affichent un état vide explicite. Le fichier importé ne garantit pas la couverture de tous les transports régionaux.

Pour une version utilisable en déplacement, intégrer les données officielles GTFS des réseaux concernés et un moteur de calcul d’itinéraires. Les disponibilités, licences et éventuelles clés d’API restent à vérifier.
