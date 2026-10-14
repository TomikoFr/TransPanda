/* Real routing semantics, with tiny independently specified GTFS fixtures. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const browser = {window: {}, setTimeout, URL, Map, Set, Date, Number, Object, Error, Array};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../assets/journey-router.js'), 'utf8'), browser);
const {createRouter} = browser.window.TransPandaRouter;

const seconds = value => value.split(':').map(Number).reduce((total, value) => total * 60 + value, 0) * 60;
const stop = (id, lon) => ({stop_id: id, stop_name: id, stop_lat: 44, stop_lon: lon});
const trip = (id, service, visits) => [service, id, id, visits.map(([index, arrival, departure = arrival, pickup = 0, dropoff = 0]) => [index, seconds(arrival), seconds(departure), pickup, dropoff])];
const route = (id, kind = 3) => ({route_id: id, route_short_name: id, route_long_name: id, route_type: String(kind), agency_name: 'Fixture'});

function fixture({stops, routes, trips, calendars, exceptions = {}, version, indexVersion = version, routeVersion = version}) {
  const files = new Map();
  const mapping = {};
  const index = {};
  routes.forEach((route, position) => {
    index[route.route_id] = position;
    mapping[route.route_id] = [...new Set(trips[position].flatMap(trip => trip[3].map(row => row[0])))];
    files.set(`routing/${position}.json`, {route_index: position, source_imported_at: routeVersion, trips: trips[position]});
  });
  files.set('catalog.json', {info: {imported_at: version}, routes, calendars: calendars || [[0, '20260101', '20261231', [1, 1, 1, 1, 1, 1, 1]]], exceptions});
  files.set('stops.json', stops.map((stop, index) => ({...stop, file: index})));
  files.set('route-stops.json', mapping);
  files.set('routing/index.json', {version: 1, files: index, source_imported_at: indexVersion});
  const loaded = [];
  return {loaded, router: createRouter({loadData: async file => {
    loaded.push(file);
    assert(files.has(file), `Unexpected file ${file}`);
    return files.get(file);
  }})};
}

function options(stops, additions = {}) {
  return {from: {label: 'Origin', lat: stops[0].stop_lat, lon: stops[0].stop_lon}, to: {label: 'Destination', lat: stops.at(-1).stop_lat, lon: stops.at(-1).stop_lon}, date: '2026-10-12', time: '09:00', walkingRadiusMeters: 50, ...additions};
}

async function tests() {
  {
    const stops = [stop('A', 0), stop('B', 0.02), stop('Unrelated1', 1), stop('Unrelated2', 1.1)];
    const {router, loaded} = fixture({stops, routes: [route('Bus'), route('Elsewhere')], trips: [[trip('slow', 0, [[0, '09:00'], [1, '09:40']]), trip('fast', 0, [[0, '09:05'], [1, '09:25']])], [trip('unrelated', 0, [[2, '09:00'], [3, '09:20']])]]});
    const result = await router.plan(options(stops.slice(0, 2)));
    assert.equal(result.status, 'ok');
    assert.equal(result.journeys[0].arrivalSeconds, seconds('09:25'));
    assert.equal(result.journeys[0].legs[0].tripId, 'fast');
    assert(!loaded.includes('routing/1.json'), 'Disconnected route must not be downloaded');
    assert.equal(result.journeys[0].legs[0].from.label, 'A');
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02), stop('B-nearby', 0.021), stop('C', 0.04), stop('D', 0.06)];
    const {router} = fixture({stops, routes: [route('1'), route('2'), route('3')], trips: [[trip('first', 0, [[0, '09:00'], [1, '09:10']])], [trip('too-tight', 0, [[2, '09:12'], [3, '09:18']]), trip('second', 0, [[2, '09:14'], [3, '09:20']])], [trip('third', 0, [[3, '09:22'], [4, '09:30']])]]});
    const result = await router.plan(options(stops));
    assert.equal(result.status, 'ok');
    const legs = result.journeys[0].legs;
    assert.deepEqual(Array.from(legs.filter(leg => leg.type === 'transit'), leg => leg.tripId), ['first', 'second', 'third']);
    const walk = legs.find(leg => leg.type === 'walk');
    assert(walk.distanceMeters > 70 && walk.distanceMeters < 90);
    assert.equal(walk.estimate, 'straight-line');
    assert.equal(result.journeys[0].arrivalSeconds, seconds('09:30'));
    assert.equal((await router.plan(options(stops, {maxTransitLegs: 2}))).status, 'no_route');
    const limited = await router.plan(options(stops, {maxRouteFiles: 2}));
    assert.equal(limited.status, 'limited');
    assert.equal(limited.limits[0].code, 'route-files');
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02), stop('C', 0.04)];
    const {router} = fixture({stops, routes: [route('1'), route('2')], trips: [[trip('first', 0, [[0, '09:00'], [1, '09:10']])], [trip('missed', 0, [[1, '09:11'], [2, '09:20']])]]});
    assert.equal((await router.plan(options(stops))).status, 'no_route', 'A one-minute transfer is not feasible');
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02)];
    const {router} = fixture({stops, routes: [route('1')], trips: [[trip('no-pickup', 0, [[0, '09:00', '09:00', 1], [1, '09:10']]), trip('no-dropoff', 0, [[0, '09:01'], [1, '09:11', '09:11', 0, 1]]), trip('reserve', 0, [[0, '09:02', '09:02', 2], [1, '09:12']]), trip('opposite', 0, [[1, '09:03'], [0, '09:13']]), trip('valid', 0, [[0, '09:05'], [1, '09:30']])]]});
    const result = await router.plan(options(stops));
    assert.equal(result.journeys[0].legs[0].tripId, 'valid');
    assert(result.warnings.some(value => value.includes('réservation')));
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02)];
    const {router} = fixture({stops, routes: [route('N')], calendars: [[0, '20260101', '20261231', [0, 0, 0, 0, 0, 0, 1]]], trips: [[trip('overnight', 0, [[0, '25:10'], [1, '25:30']])]]});
    const result = await router.plan(options(stops, {time: '01:00'}));
    assert.equal(result.status, 'ok');
    assert.equal(result.journeys[0].departureSeconds, seconds('01:10'));
    assert.equal(result.journeys[0].arrivalSeconds, seconds('01:30'));
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02)];
    const {router} = fixture({stops, routes: [route('N')], calendars: [[0, '20260101', '20261231', [1, 1, 1, 1, 1, 1, 1]]], exceptions: {20261012: [[0, 2], [1, 1]]}, trips: [[trip('removed', 0, [[0, '09:01'], [1, '09:10']]), trip('exception', 1, [[0, '09:05'], [1, '09:15']])]]});
    assert.equal((await router.plan(options(stops))).journeys[0].legs[0].tripId, 'exception');
    const nextDay = await router.plan(options(stops, {time: '23:00'}));
    assert.equal(nextDay.journeys[0].departureSeconds, DAY + seconds('09:01'));
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02)];
    const {router} = fixture({stops, routes: [route('Train', 2), route('Bus', 3)], trips: [[trip('train', 0, [[0, '09:00'], [1, '09:10']])], [trip('bus', 0, [[0, '09:05'], [1, '09:20']])]]});
    const result = await router.plan(options(stops, {modes: ['bus']}));
    assert.equal(result.journeys[0].legs[0].tripId, 'bus');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(router.plan(options(stops, {signal: controller.signal})), {name: 'AbortError'});
    await assert.rejects(router.plan(options(stops, {date: '2026-02-30'})), /date valide/);
    const invalid = await router.plan(options(stops, {maxStopTimes: 1}));
    assert.equal(invalid.status, 'limited');
    assert.equal(invalid.limits[0].code, 'stop-times');
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02)];
    const {router} = fixture({stops, routes: [route('1')], trips: [[trip('normal', 0, [[0, '09:00'], [1, '09:10']])]]});
    const result = await router.plan(options(stops, {from: {lat: 48, lon: 2}, to: {lat: 49, lon: 3}}));
    assert.equal(result.status, 'outside_coverage');
    const walking = await router.plan(options(stops, {from: {lat: 44, lon: 0.001}, to: {lat: 44, lon: 0.0012}}));
    assert.equal(walking.status, 'ok');
    assert.equal(walking.journeys[0].legs[0].type, 'walk');
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02), stop('C', 0.01)];
    const {router, loaded} = fixture({stops, routes: [route('Direct'), route('Transfer1'), route('Transfer2')], trips: [[trip('simple', 0, [[0, '09:00'], [1, '09:40']])], [trip('faster1', 0, [[0, '09:00'], [2, '09:10']])], [trip('faster2', 0, [[2, '09:12'], [1, '09:20']])]]});
    const result = await router.plan(options(stops.slice(0, 2)));
    assert.equal(result.searchPreference, 'fewest-transfers');
    assert.equal(result.coverage.searchedTransitLegs, 1);
    assert.equal(result.journeys[0].legs[0].tripId, 'simple');
    assert(result.warnings.some(value => value.includes('plus rapide')));
    assert(!loaded.includes('routing/1.json') && !loaded.includes('routing/2.json'), 'A feasible direct service should keep transfer-route downloads lazy');
  }
  {
    const stops = [stop('A', 0), stop('B', 0.02)];
    const data = {stops, routes: [route('1')], trips: [[trip('versioned', 0, [[0, '09:00'], [1, '09:10']])]], version: '2026-10-14T08:00:00Z'};
    await assert.rejects(fixture({...data, indexVersion: 'old'}).router.plan(options(stops)), /version cohérente/);
    await assert.rejects(fixture({...data, routeVersion: 'old'}).router.plan(options(stops)), /ancienne version/);
    assert.equal((await fixture(data).router.plan(options(stops))).status, 'ok');
  }
  console.log('Journey router: direct service, two transfers, walking, restrictions, calendars, overnight, lazy loading, modes, limits and cancellation passed.');
}
const DAY = 86400;
tests().catch(error => { console.error(error); process.exitCode = 1; });
