// Real, scheduled journeys between explicitly selected places; no demo journeys.
(function () {
  'use strict';
  const main = document.querySelector('main');
  if (!main) return;
  const create = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const section = create('section', 'journeys-section');
  section.id = 'trajets';
  section.setAttribute('aria-labelledby', 'journeys-heading');
  const eyebrow = create('span', 'eyebrow', 'VOS TRAJETS · HORAIRES PUBLIÉS');
  const heading = create('h2', '', 'Calculer un itinéraire');
  heading.id = 'journeys-heading';
  const introduction = create('p', 'journey-introduction', 'Choisissez une adresse ou un arrêt de départ et d’arrivée pour chercher un trajet en train, tram ou bus en Nouvelle-Aquitaine.');
  const form = create('form', 'journey-form');
  form.id = 'journey-form';
  const places = create('div', 'journey-places');
  const controls = create('div', 'journey-controls');
  const status = create('p', 'journey-status');
  status.id = 'journey-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const results = create('div', 'journey-results');
  results.id = 'journey-results';
  const note = create('p', 'journey-note', 'Horaires prévus issus des données publiées de Nouvelle-Aquitaine, avec au plus deux correspondances. Les trajets à pied sont estimés à vol d’oiseau : vérifiez les accès et les chemins. Aucun retard en temps réel n’est inclus dans le calcul.');
  let planController;
  let planSequence = 0;
  let submit;

  function cancelPlan() {
    ++planSequence;
    if (planController) planController.abort();
    planController = undefined;
    results.replaceChildren();
    status.textContent = '';
    form.removeAttribute('aria-busy');
    if (submit) submit.disabled = false;
    if (typeof window.TransPandaMap?.clearJourneyView === 'function') window.TransPandaMap.clearJourneyView();
  }

  function numericCoordinate(value, limit) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
  }

  function addressChoices(data) {
    const choices = [];
    for (const feature of Array.isArray(data.features) ? data.features : []) {
      const coordinates = feature.geometry?.coordinates;
      const label = feature.properties?.label || feature.properties?.name;
      if (!Array.isArray(coordinates) || typeof label !== 'string' || !label.trim()) continue;
      const lon = numericCoordinate(coordinates[0], 180);
      const lat = numericCoordinate(coordinates[1], 90);
      if (lat !== null && lon !== null) choices.push({ label: label, lat: lat, lon: lon, source: feature.properties?.kind === 'poi' ? 'Lieu' : 'Adresse' });
    }
    return choices.slice(0, 6);
  }

  function stopChoices(values) {
    const choices = [];
    for (const stop of Array.isArray(values) ? values : []) {
      if (!stop || typeof stop.stop_name !== 'string' || !stop.stop_name.trim()) continue;
      const lat = numericCoordinate(stop.stop_lat, 90);
      const lon = numericCoordinate(stop.stop_lon, 180);
      if (lat !== null && lon !== null) {
        choices.push({ label: `${stop.stop_name}${stop.stop_id ? ' · ' + stop.stop_id : ''}`, lat: lat, lon: lon, source: 'Arrêt publié' });
      }
    }
    return choices.slice(0, 4);
  }

  function placeField(key, labelText, placeholder) {
    const wrapper = create('div', 'journey-place');
    const label = create('label', '', labelText);
    label.htmlFor = `journey-${key}`;
    const input = create('input', 'journey-place-input');
    input.id = `journey-${key}`;
    input.type = 'search';
    input.required = true;
    input.minLength = 3;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', `journey-${key}-choices`);
    const suggestions = create('ul', 'journey-suggestions');
    suggestions.id = `journey-${key}-choices`;
    suggestions.setAttribute('role', 'listbox');
    suggestions.setAttribute('aria-label', `Suggestions : ${labelText.toLocaleLowerCase('fr')}`);
    suggestions.hidden = true;
    const fieldStatus = create('p', 'journey-place-status');
    fieldStatus.id = `journey-${key}-status`;
    fieldStatus.setAttribute('role', 'status');
    fieldStatus.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', fieldStatus.id);
    wrapper.append(label, input, suggestions, fieldStatus);
    const state = { input: input, selected: null, sequence: 0, timer: undefined, controller: undefined, choices: [], active: -1 };

    function close() {
      suggestions.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      state.active = -1;
    }

    function abortSearch() {
      ++state.sequence;
      window.clearTimeout(state.timer);
      if (state.controller) state.controller.abort();
      state.controller = undefined;
      close();
    }

    function choose(choice) {
      abortSearch();
      cancelPlan();
      state.selected = { label: choice.label, lat: choice.lat, lon: choice.lon };
      input.value = choice.label;
      fieldStatus.textContent = choice.source === 'Adresse' ? 'Adresse sélectionnée.' : `${choice.source || 'Lieu'} sélectionné.`;
      input.focus();
    }

    function activate(index) {
      state.active = index;
      const buttons = suggestions.querySelectorAll('button');
      buttons.forEach((button, position) => {
        button.setAttribute('aria-selected', String(position === index));
        button.classList.toggle('journey-suggestion-active', position === index);
      });
      if (buttons[index]) {
        input.setAttribute('aria-activedescendant', buttons[index].id);
        buttons[index].scrollIntoView({ block: 'nearest' });
      }
    }

    function showChoices(choices, addressesUnavailable, stopsUnavailable) {
      state.choices = choices;
      state.active = -1;
      suggestions.replaceChildren();
      for (const [index, choice] of choices.entries()) {
        const item = create('li');
        item.setAttribute('role', 'presentation');
        const button = create('button', 'journey-suggestion');
        button.type = 'button';
        button.id = `journey-${key}-option-${index}`;
        button.tabIndex = -1;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        button.append(create('span', 'journey-suggestion-label', choice.label), create('span', 'journey-suggestion-source', choice.source));
        // Keep input focus until click so blur does not remove the clicked choice.
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => choose(choice));
        item.append(button);
        suggestions.append(item);
      }
      suggestions.hidden = choices.length === 0;
      input.setAttribute('aria-expanded', String(choices.length > 0));
      fieldStatus.textContent = choices.length
        ? `${addressesUnavailable ? 'Adresses indisponibles : ' : ''}${choices.length} suggestions${addressesUnavailable ? ' d’arrêts publiés' : ''}. Choisissez un lieu, ou utilisez les flèches puis Entrée.`
        : addressesUnavailable ? 'Adresses indisponibles et aucun arrêt trouvé. Essayez le nom d’un arrêt.' : 'Aucun lieu trouvé. Précisez le nom de l’arrêt ou de la commune.';
      if (stopsUnavailable) fieldStatus.textContent += ' Les arrêts publiés sont momentanément indisponibles.';
    }

    async function search(term, sequence) {
      const controller = new AbortController();
      state.controller = controller;
      fieldStatus.textContent = 'Recherche de lieux…';
      const addressRequest = (async () => {
        const url = new URL('api/addresses', document.baseURI);
        url.searchParams.set('q', term);
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('Adresses indisponibles');
        return addressChoices(await response.json());
      })();
      const stopRequest = Promise.resolve().then(async () => {
        if (typeof window.staticGTFS !== 'function') throw new Error('Arrêts indisponibles');
        return stopChoices(await window.staticGTFS('/api/stops?q=' + encodeURIComponent(term)));
      });
      const [addresses, stops] = await Promise.allSettled([addressRequest, stopRequest]);
      if (sequence !== state.sequence || controller.signal.aborted) return;
      if (addresses.status === 'rejected' && stops.status === 'rejected') {
        fieldStatus.textContent = 'La recherche de lieux est indisponible. Réessayez dans un instant.';
        close();
        return;
      }
      const choices = [
        ...(addresses.status === 'fulfilled' ? addresses.value : []),
        ...(stops.status === 'fulfilled' ? stops.value : [])
      ];
      showChoices(choices, addresses.status === 'rejected', stops.status === 'rejected');
    }

    input.addEventListener('input', () => {
      abortSearch();
      cancelPlan();
      state.selected = null;
      state.choices = [];
      const term = input.value.trim();
      if (term.length < 3) {
        fieldStatus.textContent = term ? 'Saisissez au moins trois caractères.' : '';
        return;
      }
      const sequence = state.sequence;
      state.timer = window.setTimeout(() => search(term, sequence), 380);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { abortSearch(); fieldStatus.textContent = ''; return; }
      if (event.key === 'Tab') { close(); return; }
      if (suggestions.hidden || !state.choices.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        activate(state.active < 0 ? (direction === 1 ? 0 : state.choices.length - 1) : (state.active + direction + state.choices.length) % state.choices.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (state.active >= 0) choose(state.choices[state.active]);
        else fieldStatus.textContent = 'Choisissez une suggestion avec les flèches ou en cliquant dessus.';
      }
    });
    wrapper.addEventListener('focusout', event => {
      if (!wrapper.contains(event.relatedTarget)) abortSearch();
    });
    state.abortSearch = abortSearch;
    state.clearStatus = () => { fieldStatus.textContent = state.selected ? 'Lieu sélectionné.' : ''; };
    state.wrapper = wrapper;
    return state;
  }

  const from = placeField('from', 'DÉPART', 'Adresse, commune ou arrêt…');
  const to = placeField('to', 'ARRIVÉE', 'Adresse, commune ou arrêt…');
  const swap = create('button', 'journey-swap', '⇅');
  swap.type = 'button';
  swap.setAttribute('aria-label', 'Inverser le départ et l’arrivée du trajet');
  swap.addEventListener('click', () => {
    cancelPlan(); from.abortSearch(); to.abortSearch();
    [from.selected, to.selected] = [to.selected, from.selected];
    [from.input.value, to.input.value] = [to.input.value, from.input.value];
    from.clearStatus(); to.clearStatus();
  });
  places.append(from.wrapper, swap, to.wrapper);
  const dates = create('div', 'journey-date-row');
  function dateField(id, labelText, type) {
    const wrapper = create('div');
    const label = create('label', '', labelText); label.htmlFor = id;
    const input = create('input'); input.id = id; input.type = type; input.required = true;
    input.addEventListener('input', cancelPlan);
    input.addEventListener('change', cancelPlan);
    wrapper.append(label, input); dates.append(wrapper); return input;
  }
  const date = dateField('journey-date', 'DATE DE DÉPART', 'date');
  const time = dateField('journey-time', 'À PARTIR DE', 'time');
  const localParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const part = type => localParts.find(value => value.type === type).value;
  date.value = `${part('year')}-${part('month')}-${part('day')}`;
  time.value = `${part('hour')}:${part('minute')}`;
  const modes = create('fieldset', 'journey-modes');
  modes.append(create('legend', '', 'TRANSPORTS À UTILISER'));
  for (const [value, name] of [['train', 'Train'], ['tram', 'Tram / métro'], ['bus', 'Bus']]) {
    const label = create('label', 'chip');
    const input = create('input'); input.type = 'checkbox'; input.name = 'journey-mode'; input.value = value; input.checked = true;
    input.addEventListener('change', cancelPlan);
    label.append(input, document.createTextNode(name)); modes.append(label);
  }
  submit = create('button', 'primary journey-submit', 'Trouver mon itinéraire →');
  submit.type = 'submit';
  controls.append(dates, modes, submit);
  form.append(places, controls);
  section.append(eyebrow, heading, introduction, form, status, results, note);
  const demo = document.getElementById('recherche');
  if (demo) demo.before(section); else main.append(section);

  function clock(seconds) {
    if (!Number.isFinite(seconds)) return 'Heure non renseignée';
    const days = Math.floor(seconds / 86400);
    const withinDay = ((seconds % 86400) + 86400) % 86400;
    const value = `${String(Math.floor(withinDay / 3600)).padStart(2, '0')}:${String(Math.floor(withinDay / 60) % 60).padStart(2, '0')}`;
    return value + (days > 0 ? ` (+${days} jour${days > 1 ? 's' : ''})` : '');
  }
  const minutes = seconds => `${Math.max(0, Math.ceil(seconds / 60))} min`;
  const placeName = stop => stop?.label || stop?.stop_name || 'Lieu non renseigné';
  function routeMode(route) {
    const type = Number(route?.route_type);
    if (type === 2 || (type >= 100 && type < 200)) return 'Train';
    if (type === 1 || (type >= 400 && type < 500)) return 'Métro';
    if (type === 0 || (type >= 900 && type < 1000)) return 'Tram';
    return 'Bus';
  }
  function renderJourneys(response) {
    const journeys = Array.isArray(response.journeys) ? response.journeys : [];
    if (!journeys.length) {
      status.textContent = response.status === 'outside_coverage'
        ? 'Le départ ou l’arrivée est trop éloigné des arrêts disponibles. Choisissez des lieux proches du réseau publié de Nouvelle-Aquitaine.'
        : response.status === 'limited'
          ? 'La recherche a atteint sa limite avant de trouver un trajet. Essayez des arrêts plus proches ou une autre heure ; cela ne signifie pas qu’aucun trajet existe.'
          : 'Aucun trajet trouvé dans les horaires publiés pour ces lieux, cette date et ces transports. Essayez une autre heure ou des arrêts plus proches. La couverture reste limitée aux données de Nouvelle-Aquitaine.';
      return;
    }
    status.textContent = `${journeys.length} itinéraire${journeys.length > 1 ? 's' : ''} trouvé${journeys.length > 1 ? 's' : ''} · horaires prévus, heure locale de France.`;
    const title = create('h3', 'journey-results-heading', `Vos trajets du ${date.value.split('-').reverse().join('/')}`);
    title.tabIndex = -1;
    results.append(title);
    for (const [index, journey] of journeys.entries()) {
      const card = create('article', 'journey-card');
      const legs = Array.isArray(journey.legs) ? journey.legs : [];
      const transitLegs = legs.filter(leg => leg.type === 'transit');
      const summary = create('div', 'journey-card-summary');
      const heading = create('h4', '', `${clock(journey.departureSeconds)} → ${clock(journey.arrivalSeconds)}`);
      const changes = Math.max(0, transitLegs.length - 1);
      const duration = Number.isFinite(journey.arrivalSeconds) && Number.isFinite(journey.departureSeconds) ? minutes(journey.arrivalSeconds - journey.departureSeconds) : '';
      const description = create('p', '', `${duration}${duration ? ' · ' : ''}${changes ? `${changes} correspondance${changes > 1 ? 's' : ''}` : transitLegs.length ? 'Sans correspondance' : 'À pied'}`);
      summary.append(heading, description);
      if (typeof window.TransPandaMap?.showJourney === 'function') {
        const button = create('button', 'journey-map-action', 'Voir sur la carte');
        button.type = 'button';
        button.setAttribute('aria-label', `Voir le trajet ${index + 1} sur la carte`);
        button.addEventListener('click', () => window.TransPandaMap.showJourney(journey));
        summary.append(button);
      }
      card.append(summary);
      const list = create('ol', 'journey-legs');
      for (const leg of legs) {
        const item = create('li', `journey-leg journey-leg-${leg.type === 'transit' ? 'transit' : 'walk'}`);
        const timing = create('div', 'journey-leg-time', `${clock(leg.departureSeconds)} → ${clock(leg.arrivalSeconds)}`);
        const detail = create('div', 'journey-leg-detail');
        if (leg.type === 'transit') {
          const route = leg.route || {};
          const line = route.route_short_name || route.route_long_name || 'Ligne non renseignée';
          detail.append(create('strong', '', `${routeMode(route)} ${line}`));
          if (leg.headsign) detail.append(create('p', 'journey-leg-direction', `Direction ${leg.headsign}`));
          if (route.agency_name) detail.append(create('p', 'journey-leg-agency', route.agency_name));
        } else {
          const distance = Number.isFinite(leg.distanceMeters)
            ? `${Math.round(leg.distanceMeters)} m · ` : '';
          detail.append(create('strong', '', `Marche estimée · ${distance}${minutes(leg.arrivalSeconds - leg.departureSeconds)}`));
        }
        detail.append(create('p', 'journey-leg-places', `${placeName(leg.from)} → ${placeName(leg.to)}`));
        item.append(timing, detail); list.append(item);
      }
      card.append(list); results.append(card);
    }
    if (response.status === 'limited' || response.limited || response.truncated) results.append(create('p', 'journey-limit', 'La recherche a atteint sa limite : les trajets proposés peuvent ne pas être exhaustifs.'));
    for (const warning of Array.isArray(response.warnings) ? response.warnings : []) {
      if (typeof warning === 'string' && warning.trim()) results.append(create('p', 'journey-limit', warning));
    }
    title.focus({ preventScroll: true });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    cancelPlan();
    if (!from.selected || !to.selected || from.input.value !== from.selected.label || to.input.value !== to.selected.label) {
      status.textContent = 'Choisissez le départ et l’arrivée dans les suggestions pour utiliser leurs coordonnées.';
      (!from.selected ? from.input : to.input).focus();
      return;
    }
    const selectedModes = Array.from(modes.querySelectorAll('input:checked'), input => input.value);
    if (!selectedModes.length) { status.textContent = 'Sélectionnez au moins un transport.'; return; }
    if (typeof window.TransPandaRouter?.plan !== 'function') { status.textContent = 'Le calcul d’itinéraire est indisponible. Réessayez après le chargement du site.'; return; }
    const sequence = planSequence;
    const controller = new AbortController();
    planController = controller;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Recherche dans les horaires publiés…';
    try {
      const response = await window.TransPandaRouter.plan({
        from: from.selected, to: to.selected, date: date.value, time: time.value,
        modes: selectedModes, signal: controller.signal,
        onProgress: () => {
          if (sequence === planSequence && !controller.signal.aborted) status.textContent = 'Recherche dans les horaires publiés…';
        }
      });
      if (sequence !== planSequence || controller.signal.aborted) return;
      renderJourneys(response || {});
    } catch (error) {
      if (sequence !== planSequence || controller.signal.aborted) return;
      status.textContent = typeof error.message === 'string' && error.message ? error.message : 'Le calcul a échoué. Réessayez dans un instant.';
    } finally {
      if (sequence === planSequence) {
        submit.disabled = false;
        form.removeAttribute('aria-busy');
        planController = undefined;
      }
    }
  });
})();
