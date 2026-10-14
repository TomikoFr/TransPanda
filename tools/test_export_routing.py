"""Validate routing interchange against the actual static timetable exporter."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from export_routing import export, seconds
from sqlite_support import sqlite3


class RoutingExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / 'fixture.sqlite'
        self.output = self.root / 'data'
        db = sqlite3.connect(self.database)
        db.executescript('''
            CREATE TABLE agency (agency_id TEXT,agency_name TEXT);
            CREATE TABLE routes (route_id TEXT,route_short_name TEXT,route_long_name TEXT,route_type TEXT,agency_id TEXT);
            CREATE TABLE stops (stop_id TEXT,stop_name TEXT,stop_lat TEXT,stop_lon TEXT,location_type TEXT);
            CREATE TABLE trips (trip_id TEXT,route_id TEXT,service_id TEXT,trip_headsign TEXT);
            CREATE TABLE stop_times (trip_id TEXT,stop_id TEXT,stop_sequence TEXT,arrival_time TEXT,departure_time TEXT,pickup_type TEXT,drop_off_type TEXT);
            CREATE TABLE calendar (service_id TEXT,start_date TEXT,end_date TEXT,monday TEXT,tuesday TEXT,wednesday TEXT,thursday TEXT,friday TEXT,saturday TEXT,sunday TEXT);
            CREATE TABLE calendar_dates (service_id TEXT,date TEXT,exception_type TEXT);
            CREATE TABLE metadata (data TEXT);
        ''')
        db.execute('INSERT INTO agency VALUES (?,?)', ('network', 'Test network'))
        db.executemany('INSERT INTO routes VALUES (?,?,?,?,?)', [
            ('Z-route', 'Z', 'Z route', '3', 'network'),
            ('A-route', 'A', 'A route', '3', 'network'),
            ('empty', 'E', 'No trips', '3', 'network')])
        db.executemany('INSERT INTO stops VALUES (?,?,?,?,?)', [
            ('start', 'Zulu start', '44.8', '-0.5', '0'),
            ('end', 'Alpha end', '44.81', '-0.51', ''),
            ('station', 'Ignored station', '44.805', '-0.505', '1')])
        # Both route and service insertion orders intentionally differ from
        # lexical order. Re-sorting them would corrupt calendar/line references.
        db.executemany('INSERT INTO trips VALUES (?,?,?,?)', [
            ('late', 'Z-route', 'Z-service', 'Destination'),
            ('regular', 'A-route', 'A-service', 'Destination'),
            ('separate', 'A-route', 'A-service', 'Destination')])
        db.executemany('INSERT INTO calendar VALUES (?,?,?,?,?,?,?,?,?,?)', [
            ('Z-service', '20261001', '20261031', '1', '1', '1', '1', '1', '1', '1'),
            ('A-service', '20261001', '20261031', '0', '0', '0', '0', '0', '0', '0')])
        db.executemany('INSERT INTO calendar_dates VALUES (?,?,?)', [
            ('Z-service', '20261014', '2'), ('A-service', '20261014', '1')])
        db.execute('INSERT INTO metadata VALUES (?)', (json.dumps({
            'source': 'test', 'imported_at': '2026-10-14T10:00:00+00:00'}),))
        # Deliberately insert sequence 10 before 2 to verify numeric ordering.
        db.executemany('INSERT INTO stop_times VALUES (?,?,?,?,?,?,?)', [
            ('late', 'end', '10', '25:30:00', '25:31:00', '1', '3'),
            ('late', 'start', '2', '25:10:00', '25:12:00', '2', ''),
            ('late', 'station', '5', '25:20:00', '25:20:00', '3', '1'),
            ('regular', 'start', '1', '09:00:00', '09:01:00', '', '0'),
            ('regular', 'end', '2', '09:30:00', '09:30:00', '0', '2'),
            ('separate', 'start', '1', '09:05:00', '09:05:00', '3', '3'),
            ('separate', 'end', '2', '09:35:00', '09:35:00', '0', '0')])
        db.commit()
        db.close()

    def read(self, name):
        return json.loads((self.output / name).read_text(encoding='utf-8'))

    def add_trip(self, trip_id, rows):
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO trips VALUES (?,?,?,?)', (trip_id, 'Z-route', 'Z-service', 'Destination'))
            db.executemany('INSERT INTO stop_times VALUES (?,?,?,?,?,?,?)',
                           [(trip_id, *row) for row in rows])

    def test_indices_calendar_references_sequence_and_restrictions(self):
        subprocess.run([sys.executable, str(Path(__file__).with_name('export_static.py')),
                        str(self.database), str(self.output)], check=True, capture_output=True)
        before = hashlib.sha256(self.database.read_bytes()).digest()
        report = export(self.database, self.output)
        self.assertEqual(before, hashlib.sha256(self.database.read_bytes()).digest())
        catalog = self.read('catalog.json')
        index = self.read('routing/index.json')
        self.assertEqual(index['version'], 1)
        self.assertEqual(index['source_imported_at'], catalog['info']['imported_at'])
        self.assertEqual(index['files'], {route['route_id']: i for i, route in enumerate(catalog['routes'])})
        for route_index in index['files'].values():
            self.assertEqual(self.read(f'routing/{route_index}.json')['source_imported_at'],
                             catalog['info']['imported_at'])
        stop_indices = {stop['stop_id']: stop['file'] for stop in self.read('stops.json')}
        late = self.read('routing/0.json')['trips'][0]
        self.assertEqual(late[:3], [0, 'late', 'Destination'])
        self.assertEqual(late[3], [
            [stop_indices['start'], 25 * 3600 + 600, 25 * 3600 + 720, 2, 0],
            [stop_indices['end'], 25 * 3600 + 1800, 25 * 3600 + 1860, 1, 3]])
        self.assertEqual(catalog['exceptions']['20261014'], [[0, 2], [1, 1]])
        other = self.read('routing/1.json')['trips']
        self.assertEqual([trip[1] for trip in other], ['regular', 'separate'])
        self.assertEqual([trip[0] for trip in other], [1, 1])
        self.assertEqual(other[0][3][0][-2:], [0, 0])
        self.assertEqual(other[0][3][-1][-2:], [0, 2])
        self.assertEqual(other[1][3][0][-2:], [3, 3])
        self.assertEqual(self.read('routing/2.json'), {
            'route_index': 2, 'source_imported_at': catalog['info']['imported_at'], 'trips': []})
        self.assertEqual(report['exported_trips'], 3)
        self.assertEqual(report['exported_stop_times'], 6)
        self.assertEqual(report['skipped'], {})

    def test_invalid_trips_are_excluded_whole_and_not_merged(self):
        self.add_trip('bad-clock', [
            ('start', '1', '09:00:00', '09:05:00', '0', '0'),
            ('end', '2', '09:04:00', '09:06:00', '0', '0')])
        self.add_trip('bad-hidden-clock', [
            ('start', '1', '09:00:00', '09:00:00', '0', '0'),
            ('station', '2', '09:30:00', '09:30:00', '0', '0'),
            ('end', '3', '09:20:00', '09:20:00', '0', '0')])
        self.add_trip('bad-minute', [
            ('start', '1', '26:99:00', '27:00:00', '0', '0'),
            ('end', '2', '27:30:00', '27:30:00', '0', '0')])
        self.add_trip('bad-dwell', [
            ('start', '1', '10:01:00', '10:00:00', '0', '0'),
            ('end', '2', '10:30:00', '10:30:00', '0', '0')])
        self.add_trip('bad-restriction', [
            ('start', '1', '10:00:00', '10:00:00', '4', '0'),
            ('end', '2', '10:30:00', '10:30:00', '0', '0')])
        self.add_trip('bad-sequence', [
            ('start', '2x', '10:00:00', '10:00:00', '0', '0'),
            ('end', '3', '10:30:00', '10:30:00', '0', '0')])
        self.add_trip('duplicate-sequence', [
            ('start', '1', '10:00:00', '10:00:00', '0', '0'),
            ('end', '1', '10:30:00', '10:30:00', '0', '0')])
        self.add_trip('missing', [])
        self.add_trip('only-station', [('station', '1', '10:00:00', '10:00:00', '0', '0')])
        self.add_trip('duplicate-trip', [
            ('start', '1', '10:00:00', '10:00:00', '0', '0'),
            ('end', '2', '10:30:00', '10:30:00', '0', '0')])
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO trips VALUES (?,?,?,?)', ('duplicate-trip', 'A-route', 'A-service', 'Duplicate'))
        report = export(self.database, self.output)
        self.assertEqual([trip[1] for trip in self.read('routing/0.json')['trips']], ['late'])
        self.assertEqual(report['exported_trips'], 3)
        self.assertEqual(report['skipped'], {
            'invalid_trip_id': 2, 'nonmonotonic_time': 3, 'invalid_time': 1,
            'invalid_restriction': 1, 'invalid_sequence': 2,
            'fewer_than_two_platforms': 1, 'missing_stop_times': 1})
        self.assertEqual(report['source_trips'], report['exported_trips'] + sum(report['skipped'].values()))

    def test_gtfs_time_beyond_midnight_and_invalid_values(self):
        self.assertEqual(seconds('25:10:30'), 25 * 3600 + 630)
        self.assertEqual(seconds('0:00:00'), 0)
        for value in ('24:60:00', '24:00:60', '-1:00:00', '12:00', '', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                seconds(value)

    def test_absent_optional_restriction_columns_mean_normal_service(self):
        with sqlite3.connect(self.database) as db:
            db.execute('ALTER TABLE stop_times DROP COLUMN pickup_type')
            db.execute('ALTER TABLE stop_times DROP COLUMN drop_off_type')
        report = export(self.database, self.output)
        self.assertEqual(report['exported_trips'], 3)
        for route_index in (0, 1):
            for trip in self.read(f'routing/{route_index}.json')['trips']:
                self.assertTrue(all(stop[-2:] == [0, 0] for stop in trip[3]))

    def test_missing_metadata_allows_minimal_fixture_without_stamp(self):
        with sqlite3.connect(self.database) as db:
            db.execute('DROP TABLE metadata')
        export(self.database, self.output)
        self.assertIsNone(self.read('routing/index.json')['source_imported_at'])
        for route_index in (0, 1, 2):
            self.assertIsNone(self.read(f'routing/{route_index}.json')['source_imported_at'])


if __name__ == '__main__':
    unittest.main()
