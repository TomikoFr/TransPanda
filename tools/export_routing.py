"""Export complete, ordered GTFS trips for routing on static hosting.

Indices deliberately use the same SELECT statements as export_static.py. A
trip with an invalid time, sequence, or boarding restriction is excluded in its
entirety: publishing the remaining rows could invent a connection. Stops that
are not searchable platforms are omitted after validating the full sequence.
"""
import itertools
import json
import sys
import time
from collections import Counter
from pathlib import Path

from sqlite_support import sqlite3


MAX_FILE_BYTES = 25 * 1024 * 1024


def seconds(value):
    """GTFS hours can exceed 24; minutes and seconds cannot exceed 59."""
    if not isinstance(value, str):
        raise ValueError('invalid_time')
    parts = value.split(':')
    if len(parts) != 3 or any(not part.isdecimal() for part in parts):
        raise ValueError('invalid_time')
    hours, minutes, secs = map(int, parts)
    if minutes >= 60 or secs >= 60:
        raise ValueError('invalid_time')
    return hours * 3600 + minutes * 60 + secs


def restriction(value):
    # Both fields are optional in GTFS. An omitted value means normal service.
    if value in ('', None):
        return 0
    if str(value) not in ('0', '1', '2', '3'):
        raise ValueError('invalid_restriction')
    return int(value)


def validate_trip(rows):
    stops = []
    previous_sequence = -1
    previous_departure = -1
    invalid = None
    for row in rows:
        try:
            sequence_text = str(row['stop_sequence'] or '')
            if not sequence_text.isdecimal():
                raise ValueError('invalid_sequence')
            sequence = int(sequence_text)
            if sequence <= previous_sequence:
                raise ValueError('invalid_sequence')
            arrival = seconds(row['arrival_time'])
            departure = seconds(row['departure_time'])
            if arrival > departure or arrival < previous_departure:
                raise ValueError('nonmonotonic_time')
            pickup = restriction(row['pickup_type'])
            dropoff = restriction(row['drop_off_type'])
            previous_sequence = sequence
            previous_departure = departure
            if row['stop_index'] is not None:
                stops.append([row['stop_index'], arrival, departure, pickup, dropoff])
        except ValueError as error:
            invalid = invalid or str(error)
    if invalid:
        return None, invalid
    if len(stops) < 2:
        return None, 'fewer_than_two_platforms'
    return stops, None


def export(database, destination):
    database = Path(database).resolve()
    if not database.is_file():
        raise ValueError(f'GTFS database missing: {database}')
    out = Path(destination) / 'routing'
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob('*.json'):
        old.unlink()

    db = sqlite3.connect(f'file:{database}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        source_imported_at = None
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").fetchone():
            metadata_row = db.execute('SELECT data FROM metadata LIMIT 1').fetchone()
            if metadata_row:
                source_imported_at = json.loads(metadata_row[0]).get('imported_at') or None
        # Keep all three orders identical to the timetable export. In
        # particular, do not sort routes or service IDs independently.
        stop_numbers = {row['stop_id']: index for index, row in enumerate(db.execute(
            "SELECT stop_id,stop_name,stop_lat,stop_lon FROM stops WHERE location_type='' OR location_type='0' ORDER BY stop_name,stop_id"
        ))}
        route_numbers = {row['route_id']: index for index, row in enumerate(db.execute(
            'SELECT r.route_id,r.route_short_name,r.route_long_name,r.route_type,a.agency_name FROM routes r LEFT JOIN agency a ON a.agency_id=r.agency_id'
        ))}
        service_numbers = {row[0]: index for index, row in enumerate(db.execute(
            'SELECT DISTINCT service_id FROM trips'
        ))}
        duplicate_ids = {row[0] for row in db.execute(
            'SELECT trip_id FROM trips GROUP BY trip_id HAVING count(*) > 1'
        )}
        skipped = Counter()
        examples = {}
        total_trips = db.execute('SELECT count(*) FROM trips').fetchone()[0]

        def skip(reason, trip_id):
            skipped[reason] += 1
            if len(examples.setdefault(reason, [])) < 5:
                examples[reason].append(trip_id)

        db.execute('CREATE TEMP TABLE routing_stops (stop_id TEXT PRIMARY KEY, stop_index INTEGER)')
        db.executemany('INSERT INTO routing_stops VALUES (?, ?)', stop_numbers.items())
        db.execute('CREATE TEMP TABLE routing_trips (trip_id TEXT PRIMARY KEY, route_index INTEGER, service_index INTEGER, headsign TEXT)')

        def valid_trips():
            for trip in db.execute('SELECT trip_id,route_id,service_id,trip_headsign FROM trips'):
                trip_id = trip['trip_id']
                if not trip_id or trip_id in duplicate_ids:
                    skip('invalid_trip_id', trip_id)
                elif trip['route_id'] not in route_numbers:
                    skip('unknown_route', trip_id)
                else:
                    yield (trip_id, route_numbers[trip['route_id']],
                           service_numbers[trip['service_id']], trip['trip_headsign'] or '')

        db.executemany('INSERT INTO routing_trips VALUES (?, ?, ?, ?)', valid_trips())
        columns = {row['name'] for row in db.execute('PRAGMA table_info(stop_times)')}
        pickup_column = 'st.pickup_type' if 'pickup_type' in columns else "'0'"
        dropoff_column = 'st.drop_off_type' if 'drop_off_type' in columns else "'0'"
        rows = db.execute(f'''
            SELECT rt.route_index,rt.service_index,rt.trip_id,rt.headsign,
                   rs.stop_index,st.stop_sequence,st.arrival_time,st.departure_time,
                   {pickup_column} AS pickup_type,{dropoff_column} AS drop_off_type
            FROM stop_times st JOIN routing_trips rt ON rt.trip_id=st.trip_id
            LEFT JOIN routing_stops rs ON rs.stop_id=st.stop_id
            ORDER BY rt.route_index,rt.trip_id,CAST(st.stop_sequence AS INTEGER)
        ''')
        exported_trips = 0
        exported_stop_times = 0
        seen_trips = 0
        written = set()
        largest = 0
        for route_index, route_rows in itertools.groupby(rows, key=lambda row: row['route_index']):
            path = out / f'{route_index}.json'
            with path.open('w', encoding='utf-8') as target:
                target.write('{"route_index":' + str(route_index) +
                             ',"source_imported_at":' + json.dumps(source_imported_at) +
                             ',"trips":[')
                first = True
                for trip_id, trip_rows in itertools.groupby(route_rows, key=lambda row: row['trip_id']):
                    first_row = next(trip_rows)
                    seen_trips += 1
                    stops, reason = validate_trip(itertools.chain((first_row,), trip_rows))
                    if reason:
                        skip(reason, trip_id)
                        continue
                    trip = [first_row['service_index'], trip_id, first_row['headsign'], stops]
                    if not first:
                        target.write(',')
                    target.write(json.dumps(trip, ensure_ascii=False, separators=(',', ':')))
                    first = False
                    exported_trips += 1
                    exported_stop_times += len(stops)
                target.write(']}')
            size = path.stat().st_size
            if size > MAX_FILE_BYTES:
                raise ValueError(f'Routing file {path.name} exceeds Cloudflare 25 MiB limit ({size:,} bytes)')
            largest = max(largest, size)
            written.add(route_index)

        # Routes without usable trips still have a valid, cacheable empty file.
        for route_index in route_numbers.values():
            if route_index not in written:
                (out / f'{route_index}.json').write_text(
                    json.dumps({'route_index': route_index, 'source_imported_at': source_imported_at,
                                'trips': []}, separators=(',', ':')),
                    encoding='utf-8')
        no_times = db.execute('SELECT count(*) FROM routing_trips').fetchone()[0] - seen_trips
        if no_times:
            skipped['missing_stop_times'] += no_times
        index_path = out / 'index.json'
        index_path.write_text(json.dumps({'version': 1, 'source_imported_at': source_imported_at,
                                         'files': route_numbers},
                                         ensure_ascii=False, separators=(',', ':')),
                              encoding='utf-8')
        if index_path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError('Routing index exceeds Cloudflare per-file size limit')
        largest = max(largest, index_path.stat().st_size)
        files = len(list(out.glob('*.json')))
        if files > 20000:
            raise ValueError('Routing export exceeds Cloudflare file count limit')
        return {'source_trips': total_trips, 'exported_trips': exported_trips,
                'exported_stop_times': exported_stop_times, 'files': files,
                'largest_file_bytes': largest, 'skipped': dict(skipped),
                'skip_examples': examples}
    finally:
        db.close()


if __name__ == '__main__':
    started = time.monotonic()
    report = export(*sys.argv[1:3])
    report['seconds'] = round(time.monotonic() - started, 2)
    print('Routing export: ' + json.dumps(report, ensure_ascii=False), flush=True)
