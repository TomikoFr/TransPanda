#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
build_stage="checking build tools"
trap 'build_code=$?; printf "\n[TransPanda] FAILED: %s (exit %s, line %s). Copy the error directly above this message.\n" "$build_stage" "$build_code" "$LINENO" >&2; exit "$build_code"' ERR

# Workers and Pages build images may expose Python under different names.
if command -v python3 >/dev/null 2>&1; then
  python_bin=python3
elif command -v python >/dev/null 2>&1 && python -c 'import sys; assert sys.version_info.major == 3'; then
  python_bin=python
else
  printf '[TransPanda] Python 3 is missing. Set PYTHON_VERSION=3.12 in Cloudflare build variables, then rebuild.\n' >&2
  exit 1
fi
printf '[TransPanda] Python: '
"$python_bin" --version
if ! command -v curl >/dev/null 2>&1; then
  printf '[TransPanda] curl is missing in the build image.\n' >&2
  exit 1
fi

# Work outside the checkout; never publish the ZIP or SQLite source database.
build_tmp=$(mktemp -d)
trap 'rm -rf "$build_tmp"' EXIT
build_stage="checking SQLite support"
if ! "$python_bin" -c 'import sqlite3; sqlite3.connect(":memory:").execute("SELECT 1")' >/dev/null 2>&1; then
  sqlite_python=""
  for candidate in /usr/bin/python3 /usr/local/bin/python3; do
    if [ -x "$candidate" ] && "$candidate" -c 'import sqlite3; sqlite3.connect(":memory:").execute("SELECT 1")' >/dev/null 2>&1; then
      sqlite_python="$candidate"
      break
    fi
  done
  if [ -n "$sqlite_python" ]; then
    python_bin="$sqlite_python"
    printf '[TransPanda] Using system Python with SQLite: %s\n' "$python_bin"
  else
    build_stage="installing the binary SQLite driver"
    printf '[TransPanda] Python has no SQLite module; installing the verified PyPI binary driver…\n'
    "$python_bin" -m pip install --disable-pip-version-check --no-input --no-cache-dir \
      --only-binary=:all: --target "$build_tmp/python" 'pysqlite3-binary==0.5.4.post2'
    export PYTHONPATH="$build_tmp/python${PYTHONPATH:+:$PYTHONPATH}"
  fi
fi
"$python_bin" -c 'import sys; sys.path.insert(0,"tools"); from sqlite_support import sqlite3; sqlite3.connect(":memory:").execute("SELECT 1"); print("[TransPanda] SQLite ready:",sqlite3.sqlite_version)'
if [ -n "${TRANSPANDA_GTFS_DB:-}" ]; then
  gtfs_database="$TRANSPANDA_GTFS_DB"
else
  build_stage="downloading the PIGMA GTFS archive"
  printf '[TransPanda] Downloading published timetables from PIGMA…\n'
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 600 --silent --show-error \
    --output "$build_tmp/feed.zip" \
    https://www.pigma.org/public/opendata/nouvelle_aquitaine_mobilites/publication/naq-aggregated-gtfs.zip
  build_stage="importing the GTFS archive"
  printf '[TransPanda] Importing GTFS…\n'
  "$python_bin" tools/import_gtfs.py "$build_tmp/feed.zip" "$build_tmp/gtfs.sqlite"
  gtfs_database="$build_tmp/gtfs.sqlite"
fi

build_stage="exporting static timetables"
printf '[TransPanda] Exporting static timetables…\n'
"$python_bin" tools/export_static.py "$gtfs_database" "$build_tmp/site/data"
build_stage="preparing website assets"
cp index.html "$build_tmp/site/index.html"
mkdir -p "$build_tmp/site/assets"
cp assets/*.css assets/*.js "$build_tmp/site/assets/"
"$python_bin" - "$build_tmp/site" <<'PY'
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
build_stage="replacing generated deployment files"
find public -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -R "$build_tmp/site/." public/
