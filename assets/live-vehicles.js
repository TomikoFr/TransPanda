// Official TBM positions, requested only while the visitor enables the layer.
(function () {
  'use strict';
  const section = document.querySelector('.stop-map-section');
  if (!section || !window.TransPandaMap) return;
  const panel = document.createElement('div');
  panel.className = 'stop-live-panel';
  const heading = document.createElement('h4');
  heading.textContent = 'Les véhicules en temps réel';
  const explanation = document.createElement('p');
  explanation.textContent = 'Positions transmises par TBM, à Bordeaux et dans la métropole. Actualisation toutes les 30 secondes lorsque cette option est active.';
  const controls = document.createElement('div');
  controls.className = 'stop-map-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'stop-map-open';
  toggle.textContent = 'Afficher les véhicules TBM';
  toggle.setAttribute('aria-pressed', 'false');
  const recenter = document.createElement('button');
  recenter.type = 'button';
  recenter.className = 'stop-map-recenter';
  recenter.textContent = 'Recentrer sur TBM';
  recenter.disabled = true;
  const status = document.createElement('p');
  status.className = 'stop-live-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Cette fonction couvre actuellement le réseau TBM. Les autres réseaux conservent leurs horaires prévus.';
  controls.append(toggle, recenter);
  panel.append(heading, explanation, controls, status);
  section.append(panel);

  let enabled = false;
  let layer;
  let map;
  let timer;
  let controller;
  let vehicles = [];
  let generation = 0;
  const markers = new Map();
  const clock = timestamp => new Intl.DateTimeFormat('fr-FR', {timeZone:'Europe/Paris',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(timestamp * 1000));
  const fresh = vehicle => Number.isFinite(vehicle.timestamp) && Date.now()/1000 - vehicle.timestamp <= 300 && vehicle.timestamp <= Date.now()/1000 + 60;

  function popup(vehicle) {
    const element = document.createElement('div');
    element.className = 'stop-map-popup';
    const title = document.createElement('strong');
    title.textContent = vehicle.label ? `TBM · ${vehicle.label}` : 'Véhicule TBM';
    const network = document.createElement('p');
    network.textContent = 'TBM · Bordeaux Métropole';
    const updated = document.createElement('p');
    updated.textContent = `Position transmise à ${clock(vehicle.timestamp)}.`;
    element.append(title, network, updated);
    return element;
  }

  function render() {
    if (!map || !layer) return;
    const bounds = map.getBounds();
    const visible = enabled ? vehicles.filter(vehicle => fresh(vehicle) && bounds.contains([vehicle.lat, vehicle.lon])) : [];
    const ids = new Set(visible.map(vehicle => vehicle.id));
    for (const [id, marker] of markers) {
      if (!ids.has(id)) { layer.removeLayer(marker); markers.delete(id); }
    }
    for (const vehicle of visible) {
      const existing = markers.get(vehicle.id);
      if (existing) {
        existing.setLatLng([vehicle.lat, vehicle.lon]);
        existing.setPopupContent(popup(vehicle));
        continue;
      }
      const icon = L.divIcon({className:'stop-live-marker',html:'<span aria-hidden="true">↗</span>',iconSize:[30,30],iconAnchor:[15,15]});
      const marker = L.marker([vehicle.lat,vehicle.lon],{icon,keyboard:true,title:`${vehicle.label || 'Véhicule'} · TBM en temps réel`,zIndexOffset:500}).bindPopup(popup(vehicle)).addTo(layer);
      markers.set(vehicle.id, marker);
    }
  }

  function centerVehicles() {
    const positions = vehicles.filter(fresh);
    if (map && positions.length) map.fitBounds(positions.map(vehicle => [vehicle.lat,vehicle.lon]),{padding:[35,35],maxZoom:14});
  }

  async function update() {
    if (!enabled || document.hidden) return;
    const request = generation;
    controller = new AbortController();
    let timeout = setTimeout(() => controller?.abort(), 12000);
    try {
      const response = await fetch(new URL('api/live/vehicles', document.baseURI), {signal:controller.signal});
      if (!response.headers.get('content-type')?.includes('json')) throw new Error('Le service de positions est momentanément indisponible.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Positions momentanément indisponibles.');
      if (request !== generation || !enabled) return;
      const wasEmpty = vehicles.length === 0;
      vehicles = (Array.isArray(data.vehicles) ? data.vehicles : []).filter(vehicle => typeof vehicle.id === 'string' && Number.isFinite(vehicle.lat) && Math.abs(vehicle.lat)<=90 && Number.isFinite(vehicle.lon) && Math.abs(vehicle.lon)<=180 && fresh(vehicle));
      recenter.disabled = vehicles.length === 0;
      if (wasEmpty && vehicles.length) centerVehicles();
      render();
      status.textContent = vehicles.length
        ? `${vehicles.length} positions récentes TBM. Les repères orange représentent les véhicules. Dernière réception à ${clock(Number.isFinite(data.updatedAt)?data.updatedAt:Date.now()/1000)}.`
        : 'Aucune position récente transmise par TBM pour le moment. Les arrêts et leurs horaires restent disponibles.';
    } catch (error) {
      if (request !== generation || !enabled) return;
      vehicles = vehicles.filter(fresh);
      recenter.disabled = !vehicles.length;
      render();
      const message = error.name==='AbortError' ? 'Le service de positions met trop de temps à répondre.' : error instanceof SyntaxError ? 'Le service de positions est momentanément indisponible.' : error.message;
      status.textContent = `${message} ${vehicles.length?'Les dernières positions récentes restent affichées.':'Aucune position périmée n’est affichée.'}`;
    } finally {
      clearTimeout(timeout);
      if (request === generation && enabled && !document.hidden) timer = setTimeout(update, 30000);
    }
  }

  toggle.addEventListener('click', () => {
    enabled = !enabled;
    generation++;
    clearTimeout(timer);
    controller?.abort();
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? 'Masquer les véhicules TBM' : 'Afficher les véhicules TBM';
    if (enabled) {
      TransPandaMap.open();
      if (!map) {
        map = TransPandaMap.getMap();
        if (!map) { enabled=false;toggle.setAttribute('aria-pressed','false');toggle.textContent='Afficher les véhicules TBM';status.textContent='La carte doit être disponible pour afficher les positions.';return; }
        layer = L.layerGroup().addTo(map);
        map.on('moveend', render);
      }
      status.textContent = 'Chargement des positions officielles TBM…';
      update();
    } else {
      vehicles=[];
      recenter.disabled=true;
      render();
      status.textContent='Les positions sont masquées. Vous pouvez toujours consulter les horaires des arrêts.';
    }
  });
  recenter.addEventListener('click', centerVehicles);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    generation++;
    controller?.abort();
    if (enabled && !document.hidden) { render(); update(); }
  });
})();
