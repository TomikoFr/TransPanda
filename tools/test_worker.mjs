import assert from 'node:assert/strict';
import worker from '../worker.js';
import { decodeVehicleFeed } from './gtfs-rt.js';

const NOW = 1780000000;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalCaches = globalThis.caches;
Date.now = () => NOW * 1000;
const encoder = new TextEncoder();
const concat = (...items) => new Uint8Array(items.flatMap(item => Array.from(item)));
function varint(value) {
  const result = [];
  let number = BigInt(value);
  do { result.push(Number(number & 127n) | (number > 127n ? 128 : 0)); number >>= 7n; } while (number);
  return Uint8Array.from(result);
}
const integer = (field, value) => concat(varint(field * 8), varint(value));
const blob = (field, value) => concat(varint(field * 8 + 2), varint(value.length), value);
const text = (field, value) => blob(field, encoder.encode(value));
function float(field, value) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setFloat32(0, value, true);
  return concat(varint(field * 8 + 5), data);
}
function entity({ id = 'bus-42', label = 'Bus 42', routeId = 'route-1', tripId = 'trip-123',
  lat = 44.83, lon = -0.57, bearing = 90, timestamp = NOW, deleted = false,
  entityId = 'entity-42', unknown = true } = {}) {
  const trip = concat(text(1, tripId), text(5, routeId));
  const position = concat(float(1, lat), float(2, lon), float(3, bearing));
  const vehicle = concat(blob(1, trip), blob(2, position), timestamp === null ? [] : integer(5, timestamp),
    blob(8, concat(text(1, id), text(2, label))), unknown ? integer(17, 10) : []);
  return blob(2, concat(text(1, entityId), deleted ? integer(2, 1) : [], blob(4, vehicle)));
}
function feed(entries = [entity()], timestamp = NOW) {
  return concat(blob(1, concat(text(1, '2.0'), timestamp === null ? [] : integer(3, timestamp))), ...entries);
}

const store = new Map();
const pending = [];
let cachePuts = 0, fetches = 0;
const cache = {
  async match(key) { return store.get(key.url)?.clone(); },
  async put(key, response) { cachePuts++; store.set(key.url, response.clone()); },
  async delete(key) { return store.delete(key.url); }
};
globalThis.caches = { default: cache };
const context = { waitUntil(operation) { pending.push(operation); } };
const env = { ASSETS: { async fetch() { return new Response('static asset'); } } };
const request = (path, method = 'GET') => worker.fetch(new Request('https://transpanda.example' + path, { method }), env, context);
async function settle() { await Promise.all(pending.splice(0)); }
function mockFetch(handler) {
  globalThis.fetch = async (url, options) => { fetches++; return handler(new URL(url), options); };
}
function reset() { store.clear(); cachePuts = 0; fetches = 0; }
function geo(features = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-0.57, 44.83] },
  properties: { label: 'Gare Saint-Jean, Bordeaux', city: 'Bordeaux', postcode: '33800', name: 'Gare Saint-Jean' } }]) {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features }), { headers: { 'Content-Type': 'application/json' } });
}

try {
  const decoded = decodeVehicleFeed(feed());
  assert.equal(decoded.feedTimestamp, NOW);
  assert.equal(decoded.vehicles.length, 1);
  assert.equal(decoded.vehicles[0].id, 'bus-42');
  assert.equal(decoded.vehicles[0].label, 'Bus 42');
  assert.equal(decoded.vehicles[0].routeId, 'route-1');
  assert.equal(decoded.vehicles[0].tripId, 'trip-123');
  assert(Math.abs(decoded.vehicles[0].lat - 44.83) < 0.00001);
  assert(Math.abs(decoded.vehicles[0].lon + 0.57) < 0.00001);
  assert.equal(decoded.vehicles[0].bearing, 90);
  assert.equal(decodeVehicleFeed(feed([entity({ id: '', label: '' })])).vehicles[0].id, 'entity-42');
  assert.equal(decodeVehicleFeed(feed([entity({ deleted: true })])).vehicles.length, 0);
  for (const values of [{ lat: NaN }, { lon: Infinity }, { lat: 91 }, { lon: -181 }]) {
    assert.equal(decodeVehicleFeed(feed([entity(values)])).vehicles.length, 0);
  }
  assert.equal(decodeVehicleFeed(feed([entity({ bearing: -1 })])).vehicles[0].bearing, null);
  const unknownWires = concat(integer(17, 123), blob(18, encoder.encode('ignored')),
    varint(19 * 8 + 1), new Uint8Array(8), float(20, 2));
  assert.equal(decodeVehicleFeed(concat(feed(), unknownWires)).vehicles.length, 1);
  for (const bytes of [new Uint8Array(), feed().subarray(0, feed().length - 1),
    Uint8Array.from([10, 255, 127]), Uint8Array.from([0]), Uint8Array.from([11]),
    Uint8Array.from([128]), concat(blob(1, integer(3, Number.MAX_SAFE_INTEGER + 1))),
    feed([entity({ id: 'x'.repeat(2049) })])]) {
    assert.throws(() => decodeVehicleFeed(bytes));
  }
  assert.throws(() => decodeVehicleFeed(new Uint8Array(5 * 1024 * 1024 + 1)));
  assert.equal(decodeVehicleFeed(feed(Array.from({ length: 5002 }, (_, i) => entity({ id: 'bus-' + i })))).vehicles.length, 5000);
  console.log('PASS protobuf wire types, floats, bounds, identifiers, truncation and vehicle limit');

  reset();
  mockFetch((url, options) => {
    assert.equal(url.hostname, 'bdx.mecatran.com');
    assert.equal(url.pathname, '/utw/ws/gtfsfeed/vehicles/bordeaux');
    assert.equal(url.searchParams.get('apiKey'), 'opendata-bordeaux-metropole-flux-gtfs-rt');
    assert.equal(options.redirect, 'manual');
    return new Response(feed([entity(), entity({ id: 'fallback', timestamp: null }),
      entity({ id: 'stale', timestamp: NOW - 301 }), entity({ id: 'future', timestamp: NOW + 61 })]));
  });
  let result = await request('/api/live/vehicles?url=https://evil.example');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'public, max-age=30');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  let payload = await result.json();
  assert.equal(payload.network, 'TBM Bordeaux');
  assert.equal(payload.feedTimestamp, NOW);
  assert.equal(payload.updatedAt, NOW);
  assert.deepEqual(payload.vehicles.map(item => item.id), ['bus-42', 'fallback']);
  assert.equal(payload.vehicles[1].timestamp, NOW);
  await settle();
  result = await request('/api/live/vehicles');
  assert.equal(result.status, 200);
  assert.equal(fetches, 1);
  assert.equal(cachePuts, 1);
  // The cache mock ignores HTTP TTL: the worker must still reject stale data.
  Date.now = () => (NOW + 301) * 1000;
  result = await request('/api/live/vehicles');
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, 'feed_stale');
  assert.equal(fetches, 2);
  assert.equal(store.size, 0);
  Date.now = () => NOW * 1000;

  for (const [binary, status, code] of [[feed([], NOW - 301), 503, 'feed_stale'],
    [feed([], NOW + 61), 503, 'feed_future'], [feed([], null), 502, 'provider_invalid'],
    [new Uint8Array([128]), 502, 'provider_invalid']]) {
    reset(); mockFetch(() => new Response(binary));
    result = await request('/api/live/vehicles');
    assert.equal(result.status, status); assert.equal((await result.json()).code, code);
    await settle(); assert.equal(cachePuts, 0);
  }
  reset(); mockFetch(() => new Response(feed([])));
  payload = await (await request('/api/live/vehicles')).json();
  assert.deepEqual(payload.vehicles, []);
  await settle();
  console.log('PASS live freshness, timestamp fallback, cache, stale-cache and truthful empty-feed handling');

  reset();
  for (const query of ['', 'ab', 'x'.repeat(121), 'bad\naddress']) {
    result = await request('/api/addresses?q=' + encodeURIComponent(query));
    assert.equal(result.status, 400); assert.equal((await result.json()).code, 'invalid_query');
  }
  assert.equal(fetches, 0);
  const search = '12 rue &limit=900&url=https://evil.example?q=token';
  mockFetch((url, options) => {
    assert.equal(url.origin, 'https://data.geopf.fr');
    assert.equal(url.pathname, '/geocodage/search');
    assert.equal(url.searchParams.get('q'), search);
    assert.equal(url.searchParams.get('limit'), '6');
    assert.equal(url.searchParams.get('index'), 'address,poi');
    assert.equal(url.searchParams.size, 3);
    assert.equal(options.redirect, 'manual');
    return geo();
  });
  result = await request('/api/addresses?q=' + encodeURIComponent(search) + '&provider=https://evil.example');
  assert.equal(result.status, 200);
  payload = await result.json(); assert.equal(payload.features.length, 1);
  assert.equal(payload.features[0].properties.label, 'Gare Saint-Jean, Bordeaux');
  assert.equal(result.headers.get('Cache-Control'), 'public, max-age=300');
  await settle();
  assert.equal((await request('/api/addresses?q=' + encodeURIComponent(search))).status, 200);
  assert.equal(fetches, 1);
  reset();
  mockFetch(() => geo([{type:'Feature',geometry:{type:'Point',coordinates:[-0.557018,44.8254]},properties:{_type:'poi',toponym:'Gare Saint-Jean',name:['Gare Saint-Jean'],city:['Bordeaux'],category:['station de tramway','transport'],postcode:['33000','33800']}}]));
  payload = await (await request('/api/addresses?q=Gare%20Saint-Jean%20Bordeaux')).json();
  assert.equal(payload.features[0].properties.label, 'Gare Saint-Jean · station de tramway · Bordeaux');
  assert.equal(payload.features[0].properties.kind, 'poi');
  assert.deepEqual(payload.features[0].geometry.coordinates, [-0.557018,44.8254]);
  for (const features of [Array(7).fill({}), [{ type: 'Feature', geometry: { type: 'Point', coordinates: [181, 44] } }],
    [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [-0.57, 44.83] } }]]) {
    reset(); mockFetch(() => geo(features)); result = await request('/api/addresses?q=Bordeaux');
    assert.equal(result.status, 502); assert.equal((await result.json()).code, 'provider_invalid');
    await settle(); assert.equal(cachePuts, 0);
  }
  console.log('PASS fixed geocoding provider, injection-safe query, bounds and address cache');

  for (const path of ['/api/addresses?q=Bordeaux', '/api/live/vehicles']) {
    reset(); mockFetch(() => new Response('private upstream diagnostic', { status: 403 }));
    result = await request(path);
    assert.equal(result.status, 502);
    payload = await result.json(); assert.equal(payload.code, 'provider_unavailable');
    assert(!payload.error.includes('private'));
    reset(); mockFetch(() => { throw new Error('internal secret'); });
    result = await request(path); assert.equal(result.status, 502);
    assert.equal((await result.json()).code, 'provider_unavailable');
    reset(); mockFetch(() => new Response(new Uint8Array(5 * 1024 * 1024 + 1)));
    result = await request(path); assert.equal(result.status, 502);
    assert.equal((await result.json()).code, 'provider_invalid');
  }
  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (callback, timeout) => {
      assert.equal(timeout, 8000);
      return originalSetTimeout(callback, 0);
    };
    reset(); mockFetch((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    result = await request('/api/live/vehicles');
    assert.equal(result.status, 504); assert.equal((await result.json()).code, 'provider_timeout');
  } finally { globalThis.setTimeout = originalSetTimeout; }
  result = await request('/api/unknown'); assert.equal(result.status, 404);
  assert.equal((await result.json()).code, 'not_found');
  result = await request('/api'); assert.equal(result.status, 404);
  assert.equal((await result.json()).code, 'not_found');
  result = await request('/api/live/vehicles', 'POST'); assert.equal(result.status, 405);
  assert.equal(result.headers.get('Allow'), 'GET');
  assert.equal(await (await request('/assets/style.css')).text(), 'static asset');
  console.log('PASS upstream failure/timeout/size limits, French errors, method and static routing');
} finally {
  await settle();
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  globalThis.caches = originalCaches;
}
