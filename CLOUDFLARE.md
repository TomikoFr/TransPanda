# Déployer TransPanda sur Cloudflare Workers

L’adresse existante est `https://transpanda.tomikofauveau.workers.dev/`. Le Worker sert les fichiers de `public/` et deux API :

- `/api/addresses?q=...` : suggestions d’adresses IGN ;
- `/api/live/vehicles` : positions officielles récentes TBM.

Le calcul des itinéraires reste dans le navigateur, à partir des courses GTFS exportées. Aucun compte de service tiers, clé personnelle ni base payante n’est nécessaire. Les requêtes externes utilisent des fournisseurs fixes, avec validation, délais et cache.

## Intégration Git existante

Connecter `TomikoFr/TransPanda`, branche `main`, racine du dépôt. Configurer :

| Réglage | Valeur |
| --- | --- |
| Version de Node | 22.15 ou plus récente |
| Commande de déploiement | `npx wrangler deploy` |
| Commande de build séparée | vide |

Cloudflare installe les dépendances npm du fichier verrouillé. Wrangler exécute ensuite `bash tools/build_cloudflare.sh`, configuré dans `wrangler.toml`. Une commande de build séparée provoquerait un second export inutile. L’authentification du déploiement reste fournie par l’intégration Git Cloudflare.

`wrangler.toml` définit `main = "worker.js"`, le binding `ASSETS` et `run_worker_first = ["/api/*"]`. Conserver ces réglages pour que les API répondent avant les fichiers statiques. Aucun jeton Cloudflare n’est enregistré dans Git.

Le build importe le GTFS dans un dossier temporaire, exporte les horaires par groupe de 100 quais et les courses complètes par ligne, puis copie récursivement les assets. Il vérifie les limites de 20 000 fichiers et 25 MiB par fichier avant de remplacer `public/`. Si Python ne possède pas SQLite, il sélectionne un Python système compatible ou installe le pilote binaire vérifié `pysqlite3-binary` dans le dossier temporaire.

En cas d’erreur, lire les lignes au-dessus de `[TransPanda] FAILED` : elles indiquent l’étape et le code de sortie. `Running custom build failed` seul n’identifie pas la cause. Aucun token n’est requis pour télécharger le GTFS public.

## Vérification locale

```sh
npm ci
npm test
TRANSPANDA_GTFS_DB=/workspace/transpanda-data/gtfs.sqlite npm run build
npm run dev
```

Rechercher « Gare Saint-Jean Bordeaux » et « Place des Quinconces Bordeaux », sélectionner les suggestions puis calculer un trajet à une date du calendrier. Vérifier aussi les horaires par arrêt et les positions TBM. Les accès sortants nécessaires sont `www.pigma.org`, `data.geopf.fr`, `bdx.mecatran.com` et `tile.openstreetmap.org`, en plus des registres npm/PyPI pour les outils de développement.

## Actualisation et alternatives

Chaque déploiement Git renouvelle les horaires. Pour actualiser manuellement, relancer le dernier déploiement dans Cloudflare. Aucun renouvellement quotidien automatique Cloudflare n’est configuré. Les positions TBM sont récupérées à la demande et ne dépendent pas d’un nouveau build.

GitHub Pages peut publier les fichiers et le moteur de calcul, mais n’exécute pas les API du Worker. Cloudflare Pages demanderait une adaptation des fonctions serveur ; garder le Worker existant pour les trois nouvelles fonctions. Firebase n’est pas utilisé.
