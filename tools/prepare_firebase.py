"""Build Firebase Hosting assets and Cloud Run's initial read-only GTFS snapshot."""
import argparse
import shutil
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--db', type=Path, default=Path('/workspace/transpanda-data/gtfs.sqlite'))
args = parser.parse_args()
if not args.db.is_file():
    raise SystemExit('GTFS database missing: import the feed before preparing Firebase.')
with sqlite3.connect(f'file:{args.db.resolve()}?mode=ro',uri=True) as connection:
    if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise SystemExit('GTFS database integrity check failed')
public = root / 'firebase-public'
public.mkdir(exist_ok=True)
html = (root / 'index.html').read_text(encoding='utf-8')
# Exclude the external-source directory: users requested in-app timetables.
html = html.replace('<script defer src="assets/national.js"></script>', '')
(public / 'index.html').write_text(html, encoding='utf-8')
shutil.copytree(root / 'assets',public / 'assets',dirs_exist_ok=True)
runtime = root / 'runtime-data'
runtime.mkdir(exist_ok=True)
shutil.copyfile(args.db,runtime / 'gtfs.sqlite')
(runtime / 'gtfs.sqlite').chmod(0o644)
print('Firebase Hosting files and Cloud Run database snapshot prepared.')
