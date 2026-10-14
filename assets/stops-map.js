// Browse nearby stops on opening, or focus on a stop search / selected line.
// Both the complete stop index and basemap are loaded on demand.
(function () {
  'use strict';

  let stops = [];
  let allStops = [];
  let allStopsPromise;
  let loadStops;
  let mode = 'browse';
  let loading = false;
  let loadError = '';
  let visibleCount = 0;
  let omitted = 0;
  let selectedId = '';
  let section;
  let mapElement;
  let status;
  let openButton;
  let recenterButton;
  let browseButton;
  let map;
  let markerLayer;
  let clusterLayer;
  let journeyLayer;
  let journeyNote;
  let journeyActive = false;
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
    const count = mode === 'browse' ? visibleCount : stops.length;
    const plural = count === 1 ? '' : 's';
    let message;
    if (mode === 'browse' && loading) {
      message = 'Chargement des arrêts sur la carte…';
    } else if (mode === 'browse' && loadError) {
      message = 'Les arrêts n’ont pas pu être chargés. Cliquez sur « Tous les arrêts » pour réessayer, ou recherchez une ligne.';
    } else if (mode === 'browse' && !map) {
      message = 'Les arrêts apparaîtront dès l’ouverture de la carte. Zoomez pour distinguer les quais.';
    } else if (count) {
      message = `${count} arrêt${plural} ${map ? 'affiché' : 'localisé'}${plural}${mode === 'browse' ? ' dans cette zone' : ''}. Cliquez sur un repère pour consulter ses horaires prévus.`;
      if (mode === 'browse') message += ' Les nombres regroupent des arrêts proches : cliquez pour zoomer.';
    } else {
      message = mode === 'browse'
        ? 'Aucun arrêt dans cette zone du fichier de Nouvelle-Aquitaine. Déplacez la carte ou cliquez sur « Recentrer ».'
        : 'Aucun arrêt à afficher pour cette recherche. Cliquez sur « Tous les arrêts » pour explorer la carte.';
    }
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
    if (mode === 'filtered' && stops.length) {
      map.fitBounds(stops.map(stop => [stop.lat, stop.lon]), {
        padding: [28, 28],
        maxZoom: 16
      });
    } else {
      map.setView([44.84, -0.58], 12);
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
      onSelect(stop.stop_id, stop, mode === 'browse' || journeyActive);
    });
    popup.append(name, identifier, button);
    return popup;
  }

  function renderMarkers() {
    if (!map) return;
    clusterLayer.clearLayers();
    let displayed = stops;
    if (mode === 'browse') {
      const bounds = map.getBounds();
      displayed = allStops.filter(stop => bounds.contains([stop.lat, stop.lon]));
      visibleCount = displayed.length;
      // Keep a regional view light on mobile: zooming reveals individual stops.
      if (map.getZoom() < 16) {
        const groups = new Map();
        const selected = [];
        for (const stop of displayed) {
          // Keep the selected stop accessible while its popup pans the map.
          if (stop.stop_id === selectedId) {
            selected.push(stop);
            continue;
          }
          const point = map.project([stop.lat, stop.lon]);
          const cell = `${Math.floor(point.x / 64)}:${Math.floor(point.y / 64)}`;
          if (!groups.has(cell)) groups.set(cell, []);
          groups.get(cell).push(stop);
        }
        displayed = selected;
        for (const group of groups.values()) {
          if (group.length === 1) {
            displayed.push(group[0]);
            continue;
          }
          const lat = group.reduce((sum, stop) => sum + stop.lat, 0) / group.length;
          const lon = group.reduce((sum, stop) => sum + stop.lon, 0) / group.length;
          const count = String(group.length);
          const icon = window.L.divIcon({
            className: 'stop-map-cluster',
            html: `<span>${count}</span>`,
            iconSize: [42, 42],
            iconAnchor: [21, 21]
          });
          window.L.marker([lat, lon], {
            icon: icon,
            title: `${count} arrêts proches — cliquez pour zoomer`,
            keyboard: true
          }).on('click', function () {
            selectedId = '';
            map.closePopup();
            map.fitBounds(group.map(stop => [stop.lat, stop.lon]), { padding: [30, 30], maxZoom: 19 });
          }).addTo(clusterLayer);
        }
      }
    }
    const ids = new Set(displayed.map(stop => stop.stop_id));
    for (const [id, marker] of markers) {
      if (!ids.has(id)) {
        markerLayer.removeLayer(marker);
        markers.delete(id);
      }
    }
    for (const stop of displayed) {
      // Reuse visible markers so moving the map does not destroy open popups.
      if (markers.has(stop.stop_id)) continue;
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
    highlightSelection();
    updateStatus();
  }

  function normalizeStops(values) {
    const unique = new Map();
    let invalid = 0;
    for (const value of Array.isArray(values) ? values : []) {
      if (!value || typeof value.stop_id !== 'string' || !value.stop_id.trim() ||
          typeof value.stop_name !== 'string' || !value.stop_name.trim()) {
        invalid++;
        continue;
      }
      const lat = coordinate(value.stop_lat, 90);
      const lon = coordinate(value.stop_lon, 180);
      if (lat === null || lon === null) {
        invalid++;
        continue;
      }
      unique.set(value.stop_id, {
        stop_id: value.stop_id,
        stop_name: value.stop_name,
        lat: lat,
        lon: lon
      });
    }
    return { stops: Array.from(unique.values()), omitted: invalid };
  }

  function ensureAllStops() {
    if (allStopsPromise || typeof loadStops !== 'function') return;
    loading = true;
    loadError = '';
    updateStatus();
    allStopsPromise = Promise.resolve().then(loadStops).then(values => {
      allStops = normalizeStops(values).stops;
      loading = false;
      if (mode === 'browse') renderMarkers();
    }).catch(error => {
      loading = false;
      loadError = error.message;
      allStopsPromise = undefined;
      updateStatus();
    });
  }

  function showAllStops() {
    clearJourney();
    mode = 'browse';
    selectedId = '';
    omitted = 0;
    if (map) {
      ensureAllStops();
      renderMarkers();
    }
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
    clusterLayer = window.L.layerGroup().addTo(map);
    journeyLayer = window.L.layerGroup().addTo(map);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).on('tileerror', function () {
      tileFailed = true;
      updateStatus();
    }).addTo(map);
    openButton.hidden = true;
    recenterButton.disabled = false;
    map.setView([44.84, -0.58], 12);
    map.on('moveend', renderMarkers);
    if (mode === 'browse') ensureAllStops();
    else fitStops();
    renderMarkers();
  }

  function mount(container, callback, loader) {
    if (!container || typeof container.append !== 'function') return;
    if (map) map.remove();
    if (section) section.remove();
    map = undefined;
    markerLayer = undefined;
    clusterLayer = undefined;
    journeyLayer = undefined;
    markers.clear();
    tileFailed = false;
    onSelect = typeof callback === 'function' ? callback : function () {};
    loadStops = loader;

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
    description.textContent = 'Explorez les arrêts de Nouvelle-Aquitaine dès l’ouverture, ou affichez ceux d’une recherche ou d’une ligne. Zoomez sur un groupe pour voir ses quais.';
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
    browseButton = document.createElement('button');
    browseButton.type = 'button';
    browseButton.className = 'stop-map-recenter';
    browseButton.textContent = 'Tous les arrêts';
    browseButton.addEventListener('click', showAllStops);
    actions.append(openButton, browseButton, recenterButton);
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
    journeyNote = document.createElement('p');
    journeyNote.className = 'stop-map-status';
    journeyNote.textContent = 'Tracé indicatif entre les étapes du trajet. Les lignes ne suivent pas les rues ni les voies empruntées.';
    journeyNote.hidden = true;
    section.append(header, description, mapElement, status, journeyNote);
    container.append(section);
    updateStatus();
  }

  function setStops(values) {
    clearJourney();
    mode = 'filtered';
    const normalized = normalizeStops(values);
    stops = normalized.stops;
    omitted = normalized.omitted;
    if (selectedId && !stops.some(stop => stop.stop_id === selectedId)) selectedId = '';
    fitStops();
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
    showAllStops();
  }

  function clearJourney() {
    journeyActive = false;
    journeyLayer?.clearLayers();
    if (journeyNote) journeyNote.hidden = true;
  }

  function showJourney(journey) {
    const points = [];
    const platforms = [];
    const legs = Array.isArray(journey?.legs) ? journey.legs : [];
    function point(place) {
      const lat = coordinate(place?.lat ?? place?.stop_lat, 90);
      const lon = coordinate(place?.lon ?? place?.stop_lon, 180);
      return lat === null || lon === null ? null : [lat, lon];
    }
    for (const leg of legs) {
      if (leg.type !== 'transit') continue;
      for (const place of [leg.from, leg.to]) {
        const position = point(place);
        if (position && place.stop_id) platforms.push({stop_id:place.stop_id,stop_name:place.stop_name || place.label,stop_lat:position[0],stop_lon:position[1]});
      }
    }
    setStops(platforms);
    openMap();
    if (!map) return;
    journeyActive = true;
    journeyNote.hidden = false;
    for (const leg of legs) {
      const from = point(leg.from), to = point(leg.to);
      if (!from || !to) continue;
      points.push(from, to);
      L.polyline([from, to], {color:leg.type === 'walk' ? '#765f31' : '#23674f',weight:leg.type === 'walk' ? 3 : 5,dashArray:leg.type === 'walk' ? '5 6' : undefined}).addTo(journeyLayer);
    }
    if (points.length) {
      for (const [position, label] of [[points[0], 'Départ'], [points[points.length - 1], 'Arrivée']]) {
        const popup = document.createElement('strong');
        popup.textContent = label;
        L.circleMarker(position, {radius:7,color:'#183c32',fillColor:'white',fillOpacity:1,weight:3}).bindPopup(popup).addTo(journeyLayer);
      }
      map.fitBounds(points, {padding:[35,35],maxZoom:16});
    }
    section.scrollIntoView({behavior:'smooth',block:'start'});
  }

  window.TransPandaMap = { mount: mount, setStops: setStops, selectStop: selectStop, clear: clear, open:openMap, getMap:()=>map, showJourney:showJourney, clearJourneyView:()=>{if(journeyActive)showAllStops();} };
})();
