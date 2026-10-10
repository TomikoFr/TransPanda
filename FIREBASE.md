# Firebase migration: transpanda-7221e

The Firebase deployment is prepared, not deployed. The first release retains the verified Nouvelle-Aquitaine schedules. The national directory is not included in the migration: timetables should remain inside TransPanda, and additional networks must be imported before becoming selectable.

## Architecture

Firebase Hosting serves `firebase-public/`. Requests to `/api/**` are rewritten to the `transpanda-api` Cloud Run service in `europe-west1`. The browser does not need a Firebase API key. Cloud Run uses a read-only SQLite snapshot packaged in its container. No database or ZIP is committed to Git or published as a Hosting file. The existing GitHub Pages workflow remains separate.

Cloud Storage is not connected in this first version. A later revision can store versioned GTFS snapshots in a bucket and update the API from there. For now, updating schedules requires regenerating the snapshot and redeploying the Cloud Run image. The daily GitHub Pages workflow does not update Firebase.

## Prerequisites

- Project `transpanda-7221e` with Blaze billing enabled for Cloud Run and Cloud Build.
- Google Cloud CLI (`gcloud`) and Firebase CLI (`firebase`).
- An authenticated account authorized for Cloud Run deployment, Cloud Build, Artifact Registry and Firebase Hosting.
- A valid, imported GTFS SQLite database.

Never put login tokens or service-account keys in repository files or chat.

## Prepare

From the repository root, run:

```sh
python3 tools/prepare_firebase.py --db /workspace/transpanda-data/gtfs.sqlite
```

The output directories `firebase-public/` and `runtime-data/` are ignored by Git. Hosting contains only the HTML, CSS and JavaScript assets; `runtime-data/gtfs.sqlite` is included only in the Docker build.

## Deploy from an authenticated machine

Authenticate interactively on your own machine with `gcloud auth login` and `firebase login`. Then, from the repository root:

```sh
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project transpanda-7221e
gcloud run deploy transpanda-api --source . --project transpanda-7221e --region europe-west1 --allow-unauthenticated --memory 1Gi --cpu 1 --concurrency 20 --max-instances 2 --port 8080
firebase deploy --only hosting --project transpanda-7221e
```

These commands create or update cloud resources and can incur billing. The low instance limit constrains scaling, not total costs. Hosting deployment requires a successful Cloud Run deployment first. No Firestore database is needed.

## Verify

On the deployed Hosting site, check `/api/info` returns JSON. Search for “Gare Saint-Jean”, select a platform and request departures for a date within the feed calendar. Check that line search and table display work. Out-of-calendar dates can legitimately have no departures.

## Local container check

```sh
docker build -t transpanda-firebase-check .
docker run --rm -p 8080:8080 transpanda-firebase-check
```

Check `http://localhost:8080/api/info` and `/api/stops?q=Gare`. The production process reads `PORT` and `GTFS_DB` from the environment. The image uses an unprivileged user.
