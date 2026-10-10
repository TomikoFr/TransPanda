"""Export a compact, per-platform timetable for static hosting."""
import itertools
import json
from sqlite_support import sqlite3
import sys
from pathlib import Path

database = Path(sys.argv[1]).resolve()
if not database.is_file():
    raise SystemExit(f'GTFS database missing: {database}')
db = sqlite3.connect(f'file:{database}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
out = Path(sys.argv[2])
(out / 'departures').mkdir(parents=True, exist_ok=True)
for old in (out / 'departures').glob('*.json'):
    old.unlink()
chunk_size = 100
def write(name, data):
    (out / name).write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
stops = [dict(r) for r in db.execute("SELECT stop_id,stop_name,stop_lat,stop_lon FROM stops WHERE location_type='' OR location_type='0' ORDER BY stop_name,stop_id")]
stop_numbers = {s['stop_id']:i for i,s in enumerate(stops)}
for i,s in enumerate(stops): s['file'] = i
write('stops.json', stops)
routes = [dict(r) for r in db.execute('SELECT r.route_id,r.route_short_name,r.route_long_name,r.route_type,a.agency_name FROM routes r LEFT JOIN agency a ON a.agency_id=r.agency_id')]
route_numbers = {r['route_id']:i for i,r in enumerate(routes)}
route_stops = {}
for row in db.execute('SELECT DISTINCT t.route_id,st.stop_id FROM stop_times st JOIN trips t ON t.trip_id=st.trip_id'):
    if row['stop_id'] in stop_numbers:
        route_stops.setdefault(row['route_id'], []).append(stop_numbers[row['stop_id']])
write('route-stops.json', route_stops)
services = [r[0] for r in db.execute('SELECT DISTINCT service_id FROM trips')]
service_numbers = {s:i for i,s in enumerate(services)}
calendars = []
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if 'calendar' in tables:
    for r in db.execute('SELECT * FROM calendar'):
        if r['service_id'] in service_numbers:
            calendars.append([service_numbers[r['service_id']],r['start_date'],r['end_date'],[int(r[d]) for d in ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']]])
exceptions = {}
if 'calendar_dates' in tables:
    for r in db.execute('SELECT * FROM calendar_dates'):
        if r['service_id'] in service_numbers:
            exceptions.setdefault(r['date'], []).append([service_numbers[r['service_id']],int(r['exception_type'])])
write('catalog.json', {'info':json.loads(db.execute('SELECT data FROM metadata').fetchone()[0]),'routes':routes,'calendars':calendars,'exceptions':exceptions,'departures_chunk_size':chunk_size})
db.execute('CREATE TEMP TABLE export_stops (stop_id TEXT PRIMARY KEY, file INTEGER)')
db.executemany('INSERT INTO export_stops VALUES (?,?)', stop_numbers.items())
rows = db.execute("""SELECT es.file,st.departure_time,t.service_id,t.route_id,t.trip_headsign
    FROM stop_times st JOIN trips t ON st.trip_id=t.trip_id
    JOIN export_stops es ON es.stop_id=st.stop_id
    WHERE st.pickup_type!='1' ORDER BY es.file / 100,es.file""")
total = 0
written = set()
for chunk, group in itertools.groupby(rows, key=lambda r:r['file']//chunk_size):
    platforms = {str(i):[] for i in range(chunk*chunk_size,min((chunk+1)*chunk_size,len(stops)))}
    for r in group:
        try:
            h,m,s = map(int,r['departure_time'].split(':'))
            if h<0 or not 0<=m<60 or not 0<=s<60: continue
        except ValueError: continue
        platforms[str(r['file'])].append([h*3600+m*60+s,service_numbers[r['service_id']],route_numbers[r['route_id']],r['trip_headsign']])
        total += 1
    write(f'departures/{chunk}.json',platforms)
    written.add(chunk)
for chunk in range((len(stops)+chunk_size-1)//chunk_size):
    if chunk not in written:
        write(f'departures/{chunk}.json', {str(i):[] for i in range(chunk*chunk_size,min((chunk+1)*chunk_size,len(stops)))})
print(f'Exported {len(stops)} platforms, {total} scheduled departures in {len(list((out / "departures").glob("*.json")))} grouped files')
