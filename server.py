"""Static site and read-only scheduled GTFS departures. Python standard library only."""
import argparse
import json
import sqlite3
from datetime import date, timedelta
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB = Path('/workspace/transpanda-data/gtfs.sqlite')

@lru_cache(maxsize=64)
def active_services(day):
    with sqlite3.connect(DB) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        stamp = day.strftime('%Y%m%d')
        weekday = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'][day.weekday()]
        services = set()
        if 'calendar' in tables:
            services = {r[0] for r in db.execute(f'SELECT service_id FROM calendar WHERE start_date<=? AND end_date>=? AND {weekday}="1"', (stamp, stamp))}
        if 'calendar_dates' in tables:
            for service, kind in db.execute('SELECT service_id, exception_type FROM calendar_dates WHERE date=?', (stamp,)):
                if kind == '1': services.add(service)
                elif kind == '2': services.discard(service)
        return services

def seconds(value):
    try:
        h,m,s = map(int, value.split(':'))
        if h < 0 or not 0 <= m < 60 or not 0 <= s < 60: return None
        return h*3600+m*60+s
    except (ValueError, AttributeError): return None

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith('/api/'):
            # Serve only application assets, never scripts or a potential local database.
            if parsed.path not in ['/', '/index.html', '/assets/style.css', '/assets/app.js', '/assets/gtfs.js']:
                self.send_error(404)
                return
            return super().do_GET()
        if not DB.is_file(): return self.respond({'error':'Horaires indisponibles : importer le fichier GTFS.'}, 503)
        query = parse_qs(parsed.query)
        try:
            with sqlite3.connect(DB) as db:
                db.row_factory = sqlite3.Row
                if parsed.path == '/api/info':
                    return self.respond(json.loads(db.execute('SELECT data FROM metadata').fetchone()[0]))
                if parsed.path == '/api/stops':
                    term = query.get('q',[''])[0].strip()
                    if len(term) < 2: return self.respond([])
                    term = term.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')
                    rows = db.execute("SELECT stop_id,stop_name,stop_lat,stop_lon FROM stops WHERE stop_name LIKE ? ESCAPE '\\' AND (location_type='' OR location_type='0') ORDER BY stop_name LIMIT 40", ('%'+term+'%',))
                    return self.respond([dict(r) for r in rows])
                if parsed.path != '/api/departures': return self.respond({'error':'API inconnue'},404)
                day = date.fromisoformat(query.get('date',[''])[0])
                at = seconds(query.get('time',[''])[0] + ':00')
                if at is None or at >= 86400: raise ValueError('Heure invalide')
                stop = query.get('stop',[''])[0]
                if not db.execute('SELECT 1 FROM stops WHERE stop_id=?',(stop,)).fetchone():
                    return self.respond({'error':'Arrêt inconnu'},404)
                rows = db.execute('''SELECT st.departure_time,st.pickup_type,t.service_id,t.trip_headsign,t.trip_id,r.route_short_name,r.route_long_name,r.route_type,a.agency_name
                    FROM stop_times st JOIN trips t ON t.trip_id=st.trip_id JOIN routes r ON r.route_id=t.route_id
                    LEFT JOIN agency a ON a.agency_id=r.agency_id WHERE st.stop_id=?''',(stop,)).fetchall()
                results = []
                # Include services from previous days with GTFS times beyond 24:00.
                for offset in range(3):
                    service_day = day - timedelta(days=offset)
                    services = active_services(service_day)
                    for row in rows:
                        raw = seconds(row['departure_time'])
                        if raw is None or row['service_id'] not in services or row['pickup_type']=='1': continue
                        relative = raw-offset*86400
                        if at <= relative < 86400:
                            result = dict(row)
                            result['time'] = f'{relative//3600:02}:{relative//60%60:02}'
                            result['seconds'] = relative
                            result['service_date'] = service_day.isoformat()
                            results.append(result)
                results.sort(key=lambda r:r['seconds'])
                return self.respond({'departures':results[:30], 'date':day.isoformat(), 'scheduled':True})
        except ValueError:
            return self.respond({'error':'Date ou heure invalide.'},400)
        except sqlite3.Error:
            return self.respond({'error':'Base horaires indisponible.'},503)

    def respond(self, value, status=200):
        data = json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--db',type=Path,default=DB)
    args = parser.parse_args()
    DB = args.db.resolve()
    ThreadingHTTPServer(('0.0.0.0',args.port),Handler).serve_forever()
