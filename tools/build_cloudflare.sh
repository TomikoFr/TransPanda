#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Work outside the checkout; never publish the ZIP or SQLite source database.
build_tmp=$(mktemp -d)
trap 'rm -rf "$build_tmp"' EXIT
if [ -n "${TRANSPANDA_GTFS_DB:-}" ]; then
  gtfs_database="$TRANSPANDA_GTFS_DB"
else
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 600 --show-error \
    --output "$build_tmp/feed.zip" \
    https://www.pigma.org/public/opendata/nouvelle_aquitaine_mobilites/publication/naq-aggregated-gtfs.zip
  python3 tools/import_gtfs.py "$build_tmp/feed.zip" "$build_tmp/gtfs.sqlite"
  gtfs_database="$build_tmp/gtfs.sqlite"
fi

python3 tools/export_static.py "$gtfs_database" "$build_tmp/site/data"
cp index.html "$build_tmp/site/index.html"
mkdir -p "$build_tmp/site/assets"
cp assets/*.css assets/*.js "$build_tmp/site/assets/"
python3 - "$build_tmp/site" <<'PY'
import sys
from pathlib import Path
site = Path(sys.argv[1])
index = site / 'index.html'
index.write_text(index.read_text().replace('<head>', '<head><script>window.TRANSPANDA_STATIC=true;</script>'), encoding='utf-8')
# Disable Pages SPA fallback: nonexistent data paths must return 404.
(site / '404.html').write_text('<!doctype html><html lang="fr"><meta charset="utf-8"><title>Page introuvable</title><h1>Page introuvable</h1><a href="/">Retour à TransPanda</a></html>', encoding='utf-8')
files = [p for p in site.rglob('*') if p.is_file()]
if len(files) > 20000:
    raise SystemExit('Cloudflare Free file count exceeded')
if any(p.stat().st_size > 25*1024*1024 for p in files):
    raise SystemExit('Cloudflare per-file size exceeded')
print(f'Cloudflare limits checked: {len(files)} files; largest {max(p.stat().st_size for p in files):,} bytes')
PY
# Replace only the generated deployment directory, after a successful build.
mkdir -p public
find public -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -R "$build_tmp/site/." public/
