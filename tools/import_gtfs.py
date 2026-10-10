"""Import a GTFS ZIP into SQLite without extracting the archive."""
import csv
import io
import json
import os
from sqlite_support import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

def main():
    archive, destination = map(Path, sys.argv[1:3])
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.building.sqlite')
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(temporary)
    counts = {}
    with zipfile.ZipFile(archive) as z:
        for table in ['agency', 'stops', 'routes', 'trips', 'calendar', 'calendar_dates', 'stop_times']:
            if table + '.txt' not in z.namelist():
                if table in ['calendar', 'calendar_dates']:
                    continue
                raise ValueError('Missing required GTFS table: ' + table)
            with z.open(table + '.txt') as source:
                reader = csv.DictReader(io.TextIOWrapper(source, encoding='utf-8-sig', newline=''))
                columns = reader.fieldnames
                if not columns or any(not c.replace('_', '').isalnum() for c in columns):
                    raise ValueError('Invalid GTFS columns')
                fields = ','.join('"' + c + '" TEXT' for c in columns)
                db.execute(f'CREATE TABLE "{table}" ({fields})')
                insert = f'INSERT INTO "{table}" VALUES ({",".join("?" for c in columns)})'
                batch = []
                total = 0
                for row in reader:
                    batch.append(tuple(row[c] or '' for c in columns))
                    if len(batch) == 10000:
                        db.executemany(insert, batch)
                        total += len(batch)
                        batch.clear()
                db.executemany(insert, batch)
                counts[table] = total + len(batch)
                db.commit()
                print(table, counts[table], flush=True)
    for table, column in [('stops','stop_id'), ('trips','trip_id'), ('routes','route_id'), ('agency','agency_id'), ('calendar','service_id'), ('calendar_dates','date'), ('stop_times','stop_id')]:
        if table in counts:
            db.execute(f'CREATE INDEX "idx_{table}_{column}" ON "{table}" ("{column}")')
    db.execute('CREATE TABLE metadata (data TEXT)')
    db.execute('INSERT INTO metadata VALUES (?)', (json.dumps({'counts':counts, 'imported_at':datetime.now(timezone.utc).isoformat(), 'source':'https://www.pigma.org/public/opendata/nouvelle_aquitaine_mobilites/publication/naq-aggregated-gtfs.zip'}),))
    db.commit()
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise ValueError('Database integrity check failed')
    db.close()
    os.replace(temporary, destination)

if __name__ == '__main__':
    main()
