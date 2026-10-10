// Only the stops returned by the current search or line selection are mapped.
// The basemap is requested after the visitor explicitly opens the map.
(function () {
  'use strict';

  let stops = [];
  let omitted = 0;
  let selectedId = '';
  let section;
  let mapElement;
  let status;
  let openButton;
  let recenterButton;
  let map;
  let markerLayer;
  let onSelect = function () {};
  let tileFailed = false;
  const markers = new Map();

  function coordinate(value, limit) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
  }

  function updateStatus() {
    if (!status) return;
    const count = stops.length;
    const plural = count === 1 ? '' : 's';
    let message = count
      ? `${count} arrêt${plural} ${map ? 'affiché' : 'localisé'}${plural}. Cliquez sur un repère pour consulter ses horaires prévus.`
      : 'Recherchez un arrêt ou choisissez une ligne pour situer ses arrêts sur la carte.';
    if (omitted) {
      message += ` ${omitted} arrêt${omitted === 1 ? '' : 's'} sans coordonnées utilisables.`;
    }
    if (tileFailed) {
      message = 'Le fond de carte est momentanément indisponible. Les repères des arrêts restent consultables. ' + message;
    }
    status.textContent = message;
  }

  function highlightSelection() {
    for (const [id, marker] of markers) {
      const icon = marker.getElement();
      if (icon) icon.classList.toggle('stop-map-marker-selected', id === selectedId);
      marker.setZIndexOffset(id === selectedId ? 1000 : 0);
    }
  }

  function fitStops() {
    if (!map) return;
    map.invalidateSize();
    if (stops.length) {
      map.fitBounds(stops.map(stop => [stop.lat, stop.lon]), {
        padding: [28, 28],
        maxZoom: 16
      });
    } else {
      map.setView([44.84, -0.58], 10);
    }
  }

  function createPopup(stop) {
    const popup = document.createElement('div');
    popup.className = 'stop-map-popup';
    const name = document.createElement('strong');
    name.className = 'stop-map-popup-name';
    name.textContent = stop.stop_name;
    const identifier = document.createElement('p');
    identifier.className = 'stop-map-popup-id';
    identifier.textContent = `Quai : ${stop.stop_id}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stop-map-popup-action';
    button.textContent = 'Voir les horaires';
    button.addEventListener('click', function () {
      selectStop(stop.stop_id);
      onSelect(stop.stop_id);
    });
    popup.append(name, identifier, button);
    return popup;
  }

  function renderMarkers() {
    if (!map) return;
    markerLayer.clearLayers();
    markers.clear();
    for (const stop of stops) {
      const title = `${stop.stop_name} · ${stop.stop_id}`;
      const marker = window.L.marker([stop.lat, stop.lon], {
        title: title,
        alt: title,
        keyboard: true,
        autoPanOnFocus: true
      }).bindPopup(createPopup(stop));
      marker.on('popupopen', function () {
        selectedId = stop.stop_id;
        highlightSelection();
      });
      marker.addTo(markerLayer);
      markers.set(stop.stop_id, marker);
    }
    fitStops();
    highlightSelection();
    const selected = markers.get(selectedId);
    if (selected) selected.openPopup();
    updateStatus();
  }

  function openMap() {
    if (map) return;
    if (!window.L) {
      status.textContent = 'La carte n’a pas pu être chargée. Vous pouvez toujours consulter les horaires dans le tableau.';
      return;
    }
    mapElement.hidden = false;
    map = window.L.map(mapElement, { scrollWheelZoom: false });
    markerLayer = window.L.layerGroup().addTo(map);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).on('tileerror', function () {
      tileFailed = true;
      updateStatus();
    }).addTo(map);
    openButton.hidden = true;
    recenterButton.disabled = false;
    renderMarkers();
  }

  function mount(container, callback) {
    if (!container || typeof container.append !== 'function') return;
    if (map) map.remove();
    if (section) section.remove();
    map = undefined;
    markerLayer = undefined;
    markers.clear();
    tileFailed = false;
    onSelect = typeof callback === 'function' ? callback : function () {};

    section = document.createElement('section');
    section.className = 'stop-map-section';
    section.setAttribute('aria-labelledby', 'stop-map-heading');
    const header = document.createElement('div');
    header.className = 'stop-map-header';
    const heading = document.createElement('h3');
    heading.id = 'stop-map-heading';
    heading.textContent = 'Les arrêts sur la carte';
    const description = document.createElement('p');
    description.className = 'stop-map-description';
    description.textContent = 'Situez les arrêts de votre recherche ou de la ligne choisie. Le fond de carte OpenStreetMap se charge à votre demande.';
    const actions = document.createElement('div');
    actions.className = 'stop-map-actions';
    openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'stop-map-open';
    openButton.textContent = 'Ouvrir la carte';
    openButton.setAttribute('aria-controls', 'stop-map');
    openButton.addEventListener('click', openMap);
    recenterButton = document.createElement('button');
    recenterButton.type = 'button';
    recenterButton.className = 'stop-map-recenter';
    recenterButton.textContent = 'Recentrer';
    recenterButton.disabled = true;
    recenterButton.addEventListener('click', fitStops);
    actions.append(openButton, recenterButton);
    header.append(heading, actions);

    mapElement = document.createElement('div');
    mapElement.id = 'stop-map';
    mapElement.className = 'stop-map-canvas';
    mapElement.hidden = true;
    mapElement.setAttribute('role', 'region');
    mapElement.setAttribute('aria-label', 'Carte interactive des arrêts. Utilisez les boutons de zoom ou les touches fléchées pour vous déplacer.');
    status = document.createElement('p');
    status.className = 'stop-map-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    section.append(header, description, mapElement, status);
    container.append(section);
    updateStatus();
  }

  function setStops(values) {
    const unique = new Map();
    omitted = 0;
    for (const value of Array.isArray(values) ? values : []) {
      if (!value || typeof value.stop_id !== 'string' || !value.stop_id.trim() ||
          typeof value.stop_name !== 'string' || !value.stop_name.trim()) {
        omitted++;
        continue;
      }
      const lat = coordinate(value.stop_lat, 90);
      const lon = coordinate(value.stop_lon, 180);
      if (lat === null || lon === null) {
        omitted++;
        continue;
      }
      unique.set(value.stop_id, {
        stop_id: value.stop_id,
        stop_name: value.stop_name,
        lat: lat,
        lon: lon
      });
    }
    stops = Array.from(unique.values());
    if (selectedId && !unique.has(selectedId)) selectedId = '';
    renderMarkers();
    updateStatus();
  }

  function selectStop(id) {
    selectedId = typeof id === 'string' ? id : '';
    if (!map) return;
    highlightSelection();
    const marker = markers.get(selectedId);
    if (marker) {
      map.panTo(marker.getLatLng());
      marker.openPopup();
    } else {
      map.closePopup();
    }
  }

  function clear() {
    selectedId = '';
    setStops([]);
  }

  window.TransPandaMap = { mount: mount, setStops: setStops, selectStop: selectStop, clear: clear };
})();
