/* Scheduled journey planning over lazily loaded GTFS routes. No live positions. */
(function (scope) {
  'use strict';

  const DAY = 86400;
  const EARTH_RADIUS = 6371000;
  const radians = value => value * Math.PI / 180;

  function distanceMeters(a, b) {
    const latitude = radians(b.lat - a.lat);
    const longitude = radians(b.lon - a.lon);
    const value = Math.sin(latitude / 2) ** 2
      + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(longitude / 2) ** 2;
    return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
  }

  // The tram filter also includes metros and other urban rail services.
  function routeMode(route) {
    const kind = Number(route.route_type);
    if (kind === 2 || kind >= 100 && kind < 200) return 'train';
    if ([0, 1, 5, 6, 7, 12].includes(kind) || kind >= 400 && kind < 500 || kind >= 900 && kind < 1000) return 'tram';
    if ([3, 11].includes(kind) || kind >= 200 && kind < 300 || kind >= 700 && kind < 900) return 'bus';
    return 'other';
  }

  function abortIfNeeded(signal) {
    if (signal?.aborted) {
      const error = new Error('Recherche annulée.');
      error.name = 'AbortError';
      throw error;
    }
  }

  function point(input, fallbackLabel) {
    const lat = input?.lat ?? input?.stop_lat;
    const lon = input?.lon ?? input?.stop_lon;
    if (lat === null || lon === null || lat === '' || lon === ''
      || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))
      || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) {
      throw new Error('Les coordonnées de départ ou d’arrivée sont invalides.');
    }
    return {...input, lat: Number(lat), lon: Number(lon), label: String(input?.label || input?.stop_name || fallbackLabel)};
  }

  function readDate(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) {
      throw new Error('Choisissez une date et une heure valides.');
    }
    const day = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
      throw new Error('Choisissez une date valide.');
    }
    const [hours, minutes] = time.split(':').map(Number);
    return {day, seconds: hours * 3600 + minutes * 60};
  }

  function activeServices(catalog, day) {
    const stamp = day.toISOString().slice(0, 10).replaceAll('-', '');
    const weekday = (day.getUTCDay() + 6) % 7;
    const services = new Set();
    for (const calendar of catalog.calendars) {
      if (calendar[1] <= stamp && calendar[2] >= stamp && Number(calendar[3][weekday]) === 1) services.add(calendar[0]);
    }
    for (const [service, exception] of catalog.exceptions[stamp] || []) {
      if (Number(exception) === 1) services.add(service);
      if (Number(exception) === 2) services.delete(service);
    }
    return services;
  }

  function boundedNumber(input, fallback, minimum, maximum) {
    return input === undefined ? fallback : Math.min(maximum, Math.max(minimum, Number(input) || minimum));
  }

  function createRouter(configuration = {}) {
    const metadata = new Map();
    const routeCache = new Map();
    const routeCacheSize = configuration.routeCacheSize ?? 8;
    const loadData = configuration.loadData || (async (file, {signal}) => {
      const base = configuration.baseURL || new URL('data/', document.baseURI);
      const response = await fetch(new URL(file, base), {signal});
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
        throw new Error('Les données nécessaires aux itinéraires ne sont pas disponibles. Réessayez après le déploiement.');
      }
      return response.json();
    });

    async function load(file, signal) {
      abortIfNeeded(signal);
      const cache = /^routing\/\d+\.json$/.test(file) ? routeCache : metadata;
      if (cache.has(file)) {
        const result = cache.get(file);
        if (cache === routeCache) { cache.delete(file); cache.set(file, result); }
        return result;
      }
      const result = await loadData(file, {signal});
      abortIfNeeded(signal);
      cache.set(file, result);
      if (cache === routeCache) while (cache.size > routeCacheSize) cache.delete(cache.keys().next().value);
      return result;
    }

    async function searchStage(options) {
      const from = point(options.from, 'Départ');
      const to = point(options.to, 'Arrivée');
      const {day, seconds: requested} = readDate(options.date, options.time);
      const signal = options.signal;
      const walkingRadius = boundedNumber(options.walkingRadiusMeters, 1000, 10, 3000);
      const transferRadius = boundedNumber(options.transferRadiusMeters, 250, 0, 250);
      const walkingSpeed = boundedNumber(options.walkingSpeedMetersPerSecond, 1.2, 0.5, 2);
      const transferSeconds = boundedNumber(options.minTransferSeconds, 120, 120, 1800);
      const maxLegs = Math.floor(boundedNumber(options.maxTransitLegs, 3, 1, 3));
      const maxRouteFiles = Math.floor(boundedNumber(options.maxRouteFiles, configuration.maxRouteFiles ?? 120, 1, 250));
      const maxStopTimes = Math.floor(boundedNumber(options.maxStopTimes, configuration.maxStopTimes ?? 1200000, 1, 2000000));
      const maxDownloadedStopTimes = Math.floor(boundedNumber(options.maxDownloadedStopTimes, configuration.maxDownloadedStopTimes ?? 3000000, 1, 4000000));
      const maxRuns = Math.floor(boundedNumber(options.maxTripOccurrences, configuration.maxTripOccurrences ?? 150000, 1, 250000));
      const horizon = requested + boundedNumber(options.horizonSeconds, DAY, 3600, DAY);
      const modes = options.modes === undefined ? null : new Set(options.modes);
      const progress = (phase, loaded, total, message) => options.onProgress?.({phase, loaded, total, message});
      abortIfNeeded(signal);
      progress('index', 0, 4, 'Chargement des arrêts et des lignes…');
      const [catalog, rawStops, routeStops, routingIndex] = await Promise.all([
        load('catalog.json', signal), load('stops.json', signal), load('route-stops.json', signal), load('routing/index.json', signal)
      ]);
      if (!Array.isArray(catalog.routes) || !Array.isArray(catalog.calendars) || !catalog.exceptions
        || !Array.isArray(rawStops) || routingIndex.version !== 1 || !routingIndex.files || !routeStops) {
        throw new Error('Les données d’itinéraires sont incomplètes ou incompatibles.');
      }
      const sourceVersion = catalog.info?.imported_at;
      if (sourceVersion && routingIndex.source_imported_at !== sourceVersion) {
        throw new Error('Les données sont en cours de mise à jour. Rechargez la page pour utiliser une version cohérente des horaires.');
      }
      abortIfNeeded(signal);

      const stops = rawStops.map(stop => {
        try { return point(stop, 'Arrêt'); } catch (_) { return null; }
      });
      const routes = new Map(catalog.routes.filter(route => !modes || modes.has(routeMode(route))).map(route => [route.route_id, route]));
      const stopRoutes = new Map();
      for (const [id, indices] of Object.entries(routeStops)) {
        if (!routes.has(id) || !Array.isArray(indices)) continue;
        for (const index of indices) {
          if (!stops[index]) continue;
          if (!stopRoutes.has(index)) stopRoutes.set(index, new Set());
          stopRoutes.get(index).add(id);
        }
      }

      // Spatial buckets avoid comparing every platform with every other platform.
      const cellSize = 0.003;
      const cells = new Map();
      const cellKey = (lat, lon) => `${lat},${lon}`;
      for (const [index] of stopRoutes) {
        const stop = stops[index];
        const key = cellKey(Math.floor(stop.lat / cellSize), Math.floor(stop.lon / cellSize));
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(index);
      }
      function nearby(location, radius) {
        const latitudeSpan = radius / 111000;
        const longitudeSpan = radius / (111000 * Math.max(0.01, Math.cos(radians(location.lat))));
        const found = [];
        for (let latitude = Math.floor((location.lat - latitudeSpan) / cellSize); latitude <= Math.floor((location.lat + latitudeSpan) / cellSize); latitude++) {
          for (let longitude = Math.floor((location.lon - longitudeSpan) / cellSize); longitude <= Math.floor((location.lon + longitudeSpan) / cellSize); longitude++) {
            for (const index of cells.get(cellKey(latitude, longitude)) || []) {
              const distance = distanceMeters(location, stops[index]);
              if (distance <= radius) found.push({index, distance});
            }
          }
        }
        return found.sort((a, b) => a.distance - b.distance);
      }
      const originStops = nearby(from, walkingRadius);
      const destinationStops = nearby(to, walkingRadius);
      const destinationDistances = new Map(destinationStops.map(stop => [stop.index, stop.distance]));
      const result = {
        status: 'no_route', journeys: [], date: options.date, timeZone: 'Europe/Paris', limited: false,
        walkingEstimate: 'straight-line', limits: [], warnings: [],
        coverage: {info: catalog.info || {}, originStops: originStops.length, destinationStops: destinationStops.length, candidateRoutes: 0, loadedRoutes: 0, activeTrips: 0, maxTransitLegs: maxLegs, horizonSeconds: horizon - requested}
      };
      const directDistance = distanceMeters(from, to);
      if (directDistance <= walkingRadius) {
        result.journeys.push({departureSeconds: requested, arrivalSeconds: requested + Math.ceil(directDistance / walkingSpeed), legs: [{type: 'walk', from, to, departureSeconds: requested, arrivalSeconds: requested + Math.ceil(directDistance / walkingSpeed), distanceMeters: Math.round(directDistance), estimate: 'straight-line'}]});
      }
      function finish(status, code, message) {
        result.status = result.journeys.length && status !== 'limited' ? 'ok' : status;
        if (code) result.reason = {code, message};
        return result;
      }
      function limited(code, message, actual, maximum) {
        result.limited = true;
        result.limits.push({code, message, actual, maximum});
        return finish('limited', code, message);
      }
      if (!originStops.length || !destinationStops.length) {
        return finish('outside_coverage', 'no-nearby-stops', `Aucun arrêt desservi dans un rayon de marche de ${walkingRadius} m autour du départ ou de l’arrivée.`);
      }

      const transferCache = new Map();
      const neighbors = index => {
        if (!transferCache.has(index)) transferCache.set(index, nearby(stops[index], transferRadius));
        return transferCache.get(index);
      };
      const graphCache = new Map();
      const routeNeighbors = id => {
        if (!graphCache.has(id)) {
          const adjacent = new Set();
          for (const index of routeStops[id] || []) {
            if (!stops[index]) continue;
            for (const neighbor of neighbors(index)) for (const other of stopRoutes.get(neighbor.index) || []) if (other !== id) adjacent.add(other);
          }
          graphCache.set(id, adjacent);
        }
        return graphCache.get(id);
      };
      function routeDistances(candidates) {
        const distances = new Map();
        let frontier = new Set();
        for (const {index} of candidates) for (const id of stopRoutes.get(index) || []) { distances.set(id, 1); frontier.add(id); }
        for (let depth = 2; depth <= maxLegs && frontier.size; depth++) {
          const next = new Set();
          for (const id of frontier) for (const adjacent of routeNeighbors(id)) {
            if (!distances.has(adjacent)) { distances.set(adjacent, depth); next.add(adjacent); }
          }
          frontier = next;
          abortIfNeeded(signal);
        }
        return distances;
      }
      progress('index', 4, 4, 'Recherche des lignes qui peuvent relier ces lieux…');
      const forward = routeDistances(originStops);
      const backward = routeDistances(destinationStops);
      const candidates = [...forward].filter(([id, distance]) => backward.has(id) && distance + backward.get(id) <= maxLegs + 1).map(([id]) => id);
      result.coverage.candidateRoutes = candidates.length;
      if (!candidates.length) return finish('no_route', 'no-connection', 'Aucune liaison trouvée avec au maximum deux correspondances entre ces lieux.');
      if (candidates.length > maxRouteFiles) {
        return limited('route-files', 'Cette recherche couvre trop de lignes. Rapprochez le départ et l’arrivée d’arrêts précis, ou limitez les modes de transport.', candidates.length, maxRouteFiles);
      }
      const missing = candidates.filter(id => !Object.hasOwn(routingIndex.files, id) || !Number.isSafeInteger(routingIndex.files[id]) || routingIndex.files[id] < 0);
      if (missing.length) return limited('missing-route-data', 'Certaines lignes n’ont pas encore de données d’itinéraires. La recherche ne peut pas être complète.', missing.length, 0);

      const serviceDays = [-2, -1, 0, 1].map(offset => ({offset, services: activeServices(catalog, new Date(day.getTime() + offset * DAY * 1000))}));
      const runs = [];
      let loadedStopTimes = 0;
      let downloadedStopTimes = 0;
      let invalidTrips = 0;
      let hasReservations = false;
      for (let start = 0; start < candidates.length; start += 4) {
        abortIfNeeded(signal);
        const batch = candidates.slice(start, start + 4);
        const files = await Promise.all(batch.map(id => load(`routing/${routingIndex.files[id]}.json`, signal)));
        for (let position = 0; position < batch.length; position++) {
          const id = batch[position];
          const file = files[position];
          if (file.route_index !== routingIndex.files[id] || !Array.isArray(file.trips)) throw new Error('Un fichier de ligne est incompatible avec les données d’itinéraires.');
          if (sourceVersion && file.source_imported_at !== sourceVersion) {
            throw new Error('Une ligne utilise encore une ancienne version des horaires. Rechargez la page après la mise à jour des données.');
          }
          for (const trip of file.trips) {
            const times = trip?.[3];
            if (!Array.isArray(times)) { invalidTrips++; continue; }
            downloadedStopTimes += times.length;
            if (downloadedStopTimes > maxDownloadedStopTimes) return limited('downloaded-stop-times', 'Cette recherche nécessite trop de données à charger. Essayez des arrêts plus précis ou un seul mode de transport.', downloadedStopTimes, maxDownloadedStopTimes);
            const activeDays = serviceDays.filter(({offset, services}) => services.has(trip[0]) && times.length >= 2 && times[times.length - 1][1] + offset * DAY >= requested && times[0][2] + offset * DAY <= horizon);
            if (!activeDays.length) continue;
            let previous = -1;
            const valid = times.length >= 2 && Number.isSafeInteger(trip[0]) && times.every(row => {
              if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || !stops[row[0]]
                || !Number.isSafeInteger(row[1]) || !Number.isSafeInteger(row[2])
                || row[1] < previous || row[1] < 0 || row[2] < row[1]
                || ![0, 1, 2, 3].includes(row[3]) || ![0, 1, 2, 3].includes(row[4])) return false;
              previous = row[2];
              if (row[3] > 1 || row[4] > 1) hasReservations = true;
              return true;
            });
            if (!valid) { invalidTrips++; continue; }
            for (const {offset} of activeDays) {
              loadedStopTimes += times.length;
              if (loadedStopTimes > maxStopTimes) return limited('stop-times', 'Cette recherche comporte trop d’horaires actifs. Essayez des arrêts plus précis ou un seul mode de transport.', loadedStopTimes, maxStopTimes);
              runs.push({route: routes.get(id), serviceOffset: offset * DAY, tripId: trip[1], headsign: trip[2], times});
              if (runs.length > maxRuns) return limited('trip-occurrences', 'Cette recherche comporte trop de courses. Limitez les modes de transport.', runs.length, maxRuns);
            }
          }
          result.coverage.loadedRoutes++;
          progress('routes', result.coverage.loadedRoutes, candidates.length, 'Chargement des horaires des lignes utiles…');
        }
      }
      result.coverage.activeTrips = runs.length;
      if (hasReservations) result.warnings.push('Les montées et descentes qui nécessitent une réservation ne sont pas proposées.');
      if (invalidTrips) result.warnings.push(`${invalidTrips} course(s) comportant des horaires incomplets ont été exclues.`);
      if (!runs.length) return finish('no_route', 'no-active-services', 'Aucune course exploitable pour cette date et les 24 heures suivantes.');

      const origin = {kind: 'origin', to: from, arrivalSeconds: requested, readySeconds: requested, walkingMeters: 0};
      let labels = new Map(originStops.map(({index, distance}) => {
        const arrival = requested + Math.ceil(distance / walkingSpeed);
        return [index, {kind: 'walk', from, to: stops[index], prev: origin, departureSeconds: requested, arrivalSeconds: arrival, readySeconds: arrival, distanceMeters: distance, walkingMeters: distance}];
      }));
      function better(candidate, current) {
        return !current || candidate.arrivalSeconds < current.arrivalSeconds
          || candidate.arrivalSeconds === current.arrivalSeconds && candidate.walkingMeters < current.walkingMeters;
      }
      function journey(node) {
        const finalArrival = node.arrivalSeconds;
        const legs = [];
        while (node && node.kind !== 'origin') {
          if (node.kind === 'transit') {
            legs.push({type: 'transit', route: node.route, tripId: node.tripId, headsign: node.headsign, from: node.from, to: node.to, departureSeconds: node.departureSeconds, arrivalSeconds: node.arrivalSeconds});
          } else if (node.distanceMeters >= 1) {
            legs.push({type: 'walk', from: node.from, to: node.to, departureSeconds: node.departureSeconds, arrivalSeconds: node.arrivalSeconds, distanceMeters: Math.round(node.distanceMeters), estimate: 'straight-line'});
          }
          node = node.prev;
        }
        legs.reverse();
        return {departureSeconds: legs[0]?.departureSeconds ?? requested, arrivalSeconds: finalArrival, legs};
      }

      for (let round = 1; round <= maxLegs && labels.size; round++) {
        abortIfNeeded(signal);
        progress('search', round, maxLegs, `Recherche avec ${round - 1} correspondance(s)…`);
        const arrivals = new Map();
        for (const run of runs) {
          let aboard = null;
          for (let index = 0; index < run.times.length; index++) {
            const [stopIndex, rawArrival, rawDeparture, pickup, dropoff] = run.times[index];
            const arrival = rawArrival + run.serviceOffset;
            const departure = rawDeparture + run.serviceOffset;
            if (arrival > horizon) break;
            if (aboard && index > aboard.index && dropoff === 0) {
              const node = {kind: 'transit', route: run.route, tripId: run.tripId, headsign: run.headsign, from: stops[aboard.stopIndex], to: stops[stopIndex], prev: aboard.label, departureSeconds: aboard.departure, arrivalSeconds: arrival, readySeconds: arrival + transferSeconds, walkingMeters: aboard.label.walkingMeters};
              if (better(node, arrivals.get(stopIndex))) arrivals.set(stopIndex, node);
            }
            const label = labels.get(stopIndex);
            if (pickup === 0 && label && label.readySeconds <= departure && departure <= horizon
              && (!aboard || label.walkingMeters < aboard.label.walkingMeters)) {
              aboard = {label, index, stopIndex, departure};
            }
          }
        }
        for (const [index, node] of arrivals) {
          if (!destinationDistances.has(index)) continue;
          const distance = destinationDistances.get(index);
          const arrival = node.arrivalSeconds + Math.ceil(distance / walkingSpeed);
          if (arrival <= horizon) result.journeys.push(journey({kind: 'walk', from: stops[index], to, prev: node, departureSeconds: node.arrivalSeconds, arrivalSeconds: arrival, distanceMeters: distance, walkingMeters: node.walkingMeters + distance}));
        }
        const nextLabels = new Map();
        if (round === maxLegs) break;
        for (const [index, node] of arrivals) {
          for (const neighbor of neighbors(index)) {
            const arrival = node.arrivalSeconds + Math.ceil(neighbor.distance / walkingSpeed);
            if (arrival + transferSeconds > horizon) continue;
            const candidate = neighbor.index === index ? node : {kind: 'walk', from: stops[index], to: stops[neighbor.index], prev: node, departureSeconds: node.arrivalSeconds, arrivalSeconds: arrival, readySeconds: arrival + transferSeconds, distanceMeters: neighbor.distance, walkingMeters: node.walkingMeters + neighbor.distance};
            if (better(candidate, nextLabels.get(neighbor.index))) nextLabels.set(neighbor.index, candidate);
          }
        }
        labels = nextLabels;
        // Yield between rounds so a new user request can cancel a large search.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      abortIfNeeded(signal);
      result.journeys.sort((a, b) => a.arrivalSeconds - b.arrivalSeconds
        || a.legs.filter(leg => leg.type === 'transit').length - b.legs.filter(leg => leg.type === 'transit').length
        || a.legs.reduce((sum, leg) => sum + (leg.distanceMeters || 0), 0) - b.legs.reduce((sum, leg) => sum + (leg.distanceMeters || 0), 0));
      // One earliest feasible journey is clearer than duplicates through nearby platforms.
      result.journeys = result.journeys.slice(0, 1);
      return finish(result.journeys.length ? 'ok' : 'no_route', result.journeys.length ? null : 'no-feasible-departure', 'Aucun itinéraire compatible avec ces horaires et les temps de correspondance dans les 24 heures suivantes.');
    }

    // Prefer simple journeys: load direct-route corridors first, and expand to
    // one/two transfers only when a simpler scheduled journey is unavailable.
    // Within the examined corridor and transfer count, arrivals are minimized.
    async function plan(options) {
      const maximum = Math.floor(boundedNumber(options.maxTransitLegs, 3, 1, 3));
      let result;
      for (let legs = 1; legs <= maximum; legs++) {
        abortIfNeeded(options.signal);
        result = await searchStage({...options, maxTransitLegs: legs});
        result.searchPreference = 'fewest-transfers';
        result.coverage.searchedTransitLegs = legs;
        result.coverage.maxTransitLegs = maximum;
        if (result.journeys.length || result.status !== 'no_route') {
          if (result.journeys.length && legs < maximum) {
            result.warnings.push('Les trajets avec le moins de correspondances sont privilégiés. Un trajet avec davantage de correspondances peut être plus rapide.');
          }
          return result;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return result;
    }

    return {plan, clearCache() { metadata.clear(); routeCache.clear(); }};
  }

  const api = {createRouter, distanceMeters, routeMode};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.TransPandaRouter = {...api, ...createRouter()};
})(typeof window !== 'undefined' ? window : null);
