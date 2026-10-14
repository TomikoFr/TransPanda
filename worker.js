import { decodeVehicleFeed } from './tools/gtfs-rt.js';

const ADDRESS_PROVIDER = 'https://data.geopf.fr/geocodage/search';
const TBM_CATALOG = 'https://transport.data.gouv.fr/datasets/offres-de-services-bus-tram-et-scolaire-au-format-gtfs-netex-gtfs-rt-siri-lite';
// This shared key is published in the official TBM open-data catalogue above.
// It is not a personal credential and does not require a user's API token.
const TBM_VEHICLES = 'https://bdx.mecatran.com/utw/ws/gtfsfeed/vehicles/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt';
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_AGE_SECONDS = 300;
const FUTURE_TOLERANCE_SECONDS = 60;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200, ttl = 0) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer'
    }
  });
}

async function upstream(url, limit, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Workers support manual/follow only. Reject redirects along with other
    // non-2xx responses below so a provider cannot redirect to another host.
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: accept } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(502, 'provider_unavailable', 'Le fournisseur de données est momentanément indisponible.');
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new ApiError(502, 'provider_invalid', 'La réponse du fournisseur ne peut pas être utilisée.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError(502, 'provider_invalid', 'La réponse du fournisseur ne peut pas être utilisée.');
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(502, 'provider_invalid', 'La réponse du fournisseur ne peut pas être utilisée.');
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(504, 'provider_timeout', 'Le fournisseur met trop de temps à répondre. Réessayez dans un instant.');
    throw new ApiError(502, 'provider_unavailable', 'Le fournisseur de données est momentanément indisponible.');
  } finally {
    clearTimeout(timer);
  }
}

function timestampIsFresh(timestamp, now) {
  return Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp >= now - MAX_AGE_SECONDS && timestamp <= now + FUTURE_TOLERANCE_SECONDS;
}

function freshVehicles(vehicles, feedTimestamp, now) {
  return vehicles.filter(item => timestampIsFresh(item.timestamp ?? feedTimestamp, now))
    .slice(0, 5000).map(item => ({ ...item, timestamp: item.timestamp ?? feedTimestamp }));
}

function saveCache(cache, key, response, context) {
  if (!cache) return;
  const operation = cache.put(key, response.clone()).catch(() => {});
  if (context?.waitUntil) context.waitUntil(operation);
}

async function cachedResponse(cache, key) {
  try { return await cache?.match(key); } catch { return undefined; }
}

async function addresses(url, cache, context) {
  const term = (url.searchParams.get('q') || '').trim();
  if (term.length < 3 || term.length > 120 || /[\u0000-\u001f\u007f]/.test(term)) {
    throw new ApiError(400, 'invalid_query', 'Saisissez une adresse entre 3 et 120 caractères.');
  }
  const keyUrl = new URL('/api/addresses', url.origin);
  keyUrl.searchParams.set('q', term);
  const key = new Request(keyUrl);
  const cached = await cachedResponse(cache, key);
  if (cached) return cached;
  const providerUrl = new URL(ADDRESS_PROVIDER);
  providerUrl.searchParams.set('q', term);
  providerUrl.searchParams.set('limit', '6');
  providerUrl.searchParams.set('index', 'address,poi');
  const bytes = await upstream(providerUrl, 512 * 1024, 'application/geo+json, application/json');
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {}
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 6 ||
      data.features.some(feature => feature?.type !== 'Feature' || feature.geometry?.type !== 'Point' ||
        !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 2 ||
        !Number.isFinite(feature.geometry.coordinates[0]) || Math.abs(feature.geometry.coordinates[0]) > 180 ||
        !Number.isFinite(feature.geometry.coordinates[1]) || Math.abs(feature.geometry.coordinates[1]) > 90)) {
    throw new ApiError(502, 'provider_invalid', 'Les adresses reçues ne peuvent pas être utilisées.');
  }
  const string = value => {
    if (Array.isArray(value)) value = value.filter(item => typeof item === 'string').slice(0, 3).join(', ');
    return typeof value === 'string' ? value.slice(0, 240) : '';
  };
  const features = data.features.map(feature => {
    const properties = feature.properties || {};
    const name = string(properties.toponym || properties.name);
    const city = string(properties.city);
    const kind = properties._type === 'poi' ? 'poi' : 'address';
    const category = string(Array.isArray(properties.category) ? properties.category[0] : properties.category);
    const label = string(properties.label) || [name, category, city].filter(Boolean).join(' · ');
    return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: feature.geometry.coordinates.slice(0, 2) },
    properties: {
      label, name, city, kind,
      postcode: string(properties.postcode)
    }
  }; }).filter(feature => feature.properties.label);
  const result = json({ type: 'FeatureCollection', provider: 'IGN', source: ADDRESS_PROVIDER, features }, 200, 300);
  saveCache(cache, key, result, context);
  return result;
}

async function vehicles(url, cache, context) {
  const key = new Request(new URL('/api/live/vehicles', url.origin));
  const now = Math.floor(Date.now() / 1000);
  const cached = await cachedResponse(cache, key);
  if (cached) {
    try {
      const data = await cached.json();
      if (timestampIsFresh(data.feedTimestamp, now) && Array.isArray(data.vehicles)) {
        data.vehicles = freshVehicles(data.vehicles, data.feedTimestamp, now);
        return json(data, 200, 30);
      }
    } catch {}
    try { await cache?.delete(key); } catch {}
  }
  const bytes = await upstream(TBM_VEHICLES, MAX_FEED_BYTES, 'application/x-protobuf, application/octet-stream');
  let feed;
  try { feed = decodeVehicleFeed(bytes); } catch {
    throw new ApiError(502, 'provider_invalid', 'Les positions reçues ne peuvent pas être utilisées.');
  }
  const checkedAt = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(feed.feedTimestamp) || feed.feedTimestamp <= 0) {
    throw new ApiError(502, 'provider_invalid', 'Le flux reçu ne contient pas de date de mise à jour fiable.');
  }
  if (feed.feedTimestamp > checkedAt + FUTURE_TOLERANCE_SECONDS) {
    throw new ApiError(503, 'feed_future', 'La date du flux de positions est incohérente. Réessayez dans un instant.');
  }
  if (feed.feedTimestamp < checkedAt - MAX_AGE_SECONDS) {
    throw new ApiError(503, 'feed_stale', 'Les positions disponibles sont trop anciennes pour être affichées en direct.');
  }
  const result = json({ network: 'TBM Bordeaux', source: TBM_CATALOG,
    feedTimestamp: feed.feedTimestamp, vehicles: freshVehicles(feed.vehicles, feed.feedTimestamp, checkedAt), updatedAt: checkedAt }, 200, 30);
  saveCache(cache, key, result, context);
  return result;
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') {
      const response = json({ error: 'Cette requête doit utiliser GET.', code: 'method_not_allowed' }, 405);
      response.headers.set('Allow', 'GET');
      return response;
    }
    try {
      const cache = globalThis.caches?.default;
      if (url.pathname === '/api/addresses') return await addresses(url, cache, context);
      if (url.pathname === '/api/live/vehicles') return await vehicles(url, cache, context);
      return json({ error: 'Ce service est introuvable.', code: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      return json({ error: 'Le service est momentanément indisponible.', code: 'service_unavailable' }, 503);
    }
  }
};
