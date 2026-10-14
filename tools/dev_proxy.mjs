// Local workerd cannot resolve external hosts in environments that require an
// HTTP CONNECT proxy. Miniflare's supported outboundService hook forwards only
// TransPanda's two official providers through that injected proxy. TLS remains
// verified, including the environment's additional certificate authorities.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCACertificates } from 'node:tls';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { EnvHttpProxyAgent, fetch } from 'undici';

const root = fileURLToPath(new URL('../', import.meta.url));
const portText = process.env.TRANSPANDA_DEV_PORT || '8001';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  throw new Error('TRANSPANDA_DEV_PORT doit être un port entre 1 et 65535.');
}
const directory = join(root, 'public');
try { await stat(join(directory, 'index.html')); } catch {
  throw new Error('Le site statique est absent. Lancez npm run build avant le serveur de développement.');
}

// Node already loads NODE_EXTRA_CA_CERTS at startup. When SSL_CERT_FILE is
// supplied too, retain Node's default roots and append that trusted CA bundle.
let tls;
if (process.env.SSL_CERT_FILE) {
  tls = { ca: [...getCACertificates('default'), await readFile(process.env.SSL_CERT_FILE, 'utf8')] };
}
const agent = new EnvHttpProxyAgent(tls ? { requestTls: tls, proxyTls: tls } : {});
const temporary = await mkdtemp(join(tmpdir(), 'transpanda-worker-'));
let runtime;
let stopping = false;
// Miniflare also installs synchronous signal/exit hooks. Keep removal of our
// owned temporary directory reliable even when its hook exits immediately.
process.on('exit', () => {
  try { rmSync(temporary, { recursive: true, force: true }); } catch {}
});

function allowedProvider(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.username || url.password) return false;
  if (url.origin === 'https://data.geopf.fr' && url.pathname === '/geocodage/search') {
    const term = (url.searchParams.get('q') || '').trim();
    return term.length >= 3 && term.length <= 120 && url.searchParams.get('limit') === '6' &&
      ['address', 'poi', 'address,poi'].includes(url.searchParams.get('index') || 'address') &&
      [...url.searchParams.keys()].every(key => ['q', 'limit', 'index'].includes(key));
  }
  // The shared access key below is published by TBM in its open-data catalogue:
  // https://transport.data.gouv.fr/datasets/offres-de-services-bus-tram-et-scolaire-au-format-gtfs-netex-gtfs-rt-siri-lite
  return url.origin === 'https://bdx.mecatran.com' && url.pathname === '/utw/ws/gtfsfeed/vehicles/bordeaux' &&
    url.searchParams.size === 1 && url.searchParams.get('apiKey') === 'opendata-bordeaux-metropole-flux-gtfs-rt';
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  let failed = false;
  try { await runtime?.dispose(); } catch { failed = true; }
  try { await agent.close(); } catch { failed = true; }
  try { await rm(temporary, { recursive: true, force: true }); } catch { failed = true; }
  process.exit(exitCode || (failed ? 1 : 0));
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  const bundled = await build({ entryPoints: [join(root, 'worker.js')], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: Number(portText), cf: false, logRequests: false,
    telemetry: { enabled: false }, resourceTmpPath: temporary,
    name: 'transpanda-local', compatibilityDate: '2026-10-10',
    modulesRoot: temporary,
    modules: [{ type: 'ESModule', path: join(temporary, 'worker.mjs'), contents: bundled.outputFiles[0].text }],
    assets: { directory, binding: 'ASSETS', run_worker_first: ['/api/*'],
      routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: '404-page' } },
    outboundService: async request => {
      if (!allowedProvider(request)) return new Response('Destination indisponible.', { status: 403 });
      try {
        return await fetch(request.url, { dispatcher: agent, method: 'GET', headers: request.headers,
          redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) });
      } catch {
        return new Response('Fournisseur momentanément indisponible.', { status: 502 });
      }
    }
  }));
  console.log(`TransPanda : ${await runtime.ready}`);
  console.log('Les fournisseurs IGN et TBM utilisent le proxy configuré, avec vérification TLS.');
} catch (error) {
  console.error('Le serveur local ne peut pas démarrer :', error.message);
  await stop(1);
}
