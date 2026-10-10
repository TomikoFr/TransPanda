"""Prepare a national network directory from the official transport catalogue.

The directory contains public dataset pages, never credentials or download URLs.
It describes available sources, not imported timetable coverage.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

datasets = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
networks = []
for dataset in datasets:
    resources = [r for r in dataset.get('resources', []) if r.get('format', '').lower() == 'gtfs' and r.get('is_available')]
    if not resources:
        continue
    page = dataset.get('page_url', '')
    parsed = urlparse(page)
    if parsed.scheme != 'https' or parsed.hostname != 'transport.data.gouv.fr':
        continue
    networks.append({
        'id': dataset['id'],
        'title': dataset['title'],
        'publisher': dataset.get('publisher', {}).get('name', ''),
        'areas': sorted({a.get('nom', '') for a in dataset.get('covered_area', []) if a.get('nom')}),
        'url': page,
        'licence': dataset.get('licence', ''),
        'resources': len(resources),
    })
destination = Path(sys.argv[2])
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps({'updated': datetime.now(timezone.utc).isoformat(), 'networks': sorted(networks, key=lambda n:n['title'])}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'{len(networks)} available GTFS datasets indexed; timetables not imported')
