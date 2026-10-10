# Deploy TransPanda on Cloudflare Pages

## Existing Workers deployment

The existing address `https://transpanda.tomikofauveau.workers.dev/` uses **Workers**, not Pages. It can also serve the static site using Workers Static Assets. `wrangler.toml` configures the worker name `transpanda`, the generated `public/` assets and their build command.

If keeping this Worker with Git integration, select the `main` branch, leave the root directory at the repository root, and use **Deploy command: `npx wrangler deploy`**. Wrangler executes the build command defined in `wrangler.toml`. Leave the separate build command blank to avoid building twice. If the interface requires a separate build command, use `bash tools/build_cloudflare.sh`; the additional rebuild during deploy is redundant but produces the same assets. No account ID, API token or secret is committed. Cloudflare's Git integration authenticates its own deployment.

The Workers URL is only verified after a successful deployment and functional checks. A local networking refusal from the onboarding proxy does not establish the website's state.

## Pages alternative

Use **Pages**, not a Worker. Connect `TomikoFr/TransPanda` and configure:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | `bash tools/build_cloudflare.sh` |
| Build output directory | `public` |
| Root directory | Repository root (leave blank) |

No Firebase account, API key, database service, or environment secret is needed. The build downloads the public Nouvelle-Aquitaine GTFS, imports it temporarily and exports JSON files grouping 100 platforms per file. The browser searches lines, selects their stops and computes scheduled departures from calendar rules directly inside TransPanda. The national external-link directory is removed. This deployment still covers Nouvelle-Aquitaine, not all France.

The build checks the Pages Free limits of 20,000 files and 25 MiB per file before replacing `public/`. Raw ZIPs and SQLite files are never deployed. Data is refreshed on each build; there is no automatic daily Cloudflare refresh configured. New GitHub commits trigger builds once the Git integration is active. To refresh manually, use **Deployments → Retry deployment** on the latest production deployment. Scheduled builds can be configured later with a Cloudflare deploy hook.

After deployment succeeds, open the Pages URL shown by Cloudflare. Search for “Gare Saint-Jean” and choose a platform, or search for line “D”, choose TBM and select its platform. Verify the table for a date covered by the feed. These are scheduled times, not live delays. No user data or favorites are synchronized across browsers.

## Local check

Run the full build:

```sh
bash tools/build_cloudflare.sh
python3 -m http.server 8003 --directory public
```

To reuse an already validated SQLite database locally:

```sh
TRANSPANDA_GTFS_DB=/workspace/transpanda-data/gtfs.sqlite bash tools/build_cloudflare.sh
```

Firebase configuration and the independent GitHub Pages workflow remain in the repository; neither deploys to Cloudflare. The new hosting is only live after Cloudflare reports a successful deployment.
