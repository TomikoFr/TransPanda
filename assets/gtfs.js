// Published scheduled departures, kept separate from the illustrative itinerary prototype.
const timetable=document.createElement('section');
timetable.className='results';timetable.id='horaires';
timetable.innerHTML=`<div class="results-title"><div><span class="eyebrow">DONNÉES PUBLIÉES · PIGMA / NOUVELLE-AQUITAINE MOBILITÉS</span><h2>Les horaires à votre arrêt</h2></div><span class="demo-tag">HORAIRES PRÉVUS</span></div><p>Recherchez un arrêt, puis consultez ses départs pour le jour choisi. Heure locale de France. Sans information de retard en temps réel.</p><form id="gtfs-form" class="panel"><label for="stop-query">NOM DE L’ARRÊT</label><div class="field"><input id="stop-query" type="search" placeholder="Ex. Gare, Quinconces, Mairie…" autocomplete="off" minlength="2" required><button type="button" id="find-stops">Rechercher</button></div><label for="stop-choice">ARRÊTS TROUVÉS (QUAI EXACT)</label><div class="field"><select id="stop-choice" required><option value="">Recherchez un arrêt</option></select></div><div class="date-row"><div><label for="gtfs-date">DATE DE CIRCULATION</label><input id="gtfs-date" type="date" required></div><div><label for="gtfs-time">À PARTIR DE</label><input id="gtfs-time" type="time" value="09:00" required></div></div><button class="primary" style="margin-top:18px">Afficher les départs →</button></form><p id="gtfs-status" role="status" aria-live="polite"></p><div id="gtfs-departures"></div><p id="gtfs-source"></p>`;
document.querySelector('main').prepend(timetable);
const el=id=>document.getElementById(id);
el('gtfs-date').value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris'}).format(new Date());
let stopRequest=0,departureRequest=0;
async function api(path){if(location.hostname.endsWith('github.io'))return window.staticGTFS(path);const response=await fetch(path);if(!response.headers.get('content-type')?.includes('json'))return window.staticGTFS(path);const data=await response.json();if(!response.ok)throw new Error(data.error||'Service indisponible');return data;}
async function findStops(){const term=el('stop-query').value.trim();if(term.length<2){el('gtfs-status').textContent='Saisissez au moins deux caractères.';return;}const request=++stopRequest;++departureRequest;el('stop-choice').replaceChildren(new Option('Recherche en cours…',''));el('gtfs-departures').replaceChildren();el('gtfs-status').textContent='Recherche des arrêts…';try{const stops=await api('/api/stops?q='+encodeURIComponent(term));if(request!==stopRequest)return;el('stop-choice').replaceChildren(new Option('Choisissez votre arrêt',''));for(const stop of stops)el('stop-choice').add(new Option(`${stop.stop_name} · ${stop.stop_id}`,stop.stop_id));el('gtfs-status').textContent=stops.length?`${stops.length} arrêts trouvés${stops.length===40?' (limite de 40, précisez votre recherche)':''}. Sélectionnez le quai souhaité.`:'Aucun arrêt trouvé dans ce fichier. Essayez un autre nom.';}catch(error){if(request===stopRequest){el('stop-choice').replaceChildren(new Option('Recherche indisponible',''));el('gtfs-status').textContent=error.message;}}}
el('find-stops').onclick=findStops;
el('stop-query').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();findStops();}});
el('stop-query').addEventListener('input',()=>{++stopRequest;++departureRequest;el('stop-choice').replaceChildren(new Option('Recherchez un arrêt',''));el('gtfs-departures').replaceChildren();});
el('gtfs-form').onsubmit=async event=>{event.preventDefault();const request=++departureRequest;el('gtfs-departures').replaceChildren();el('gtfs-status').textContent='Chargement des horaires…';try{const query=new URLSearchParams({stop:el('stop-choice').value,date:el('gtfs-date').value,time:el('gtfs-time').value});const result=await api('/api/departures?'+query);if(request!==departureRequest)return;el('gtfs-status').textContent=result.departures.length?`${result.departures.length} départs prévus le ${result.date.split('-').reverse().join('/')}.`:'Aucun départ prévu après cette heure pour ce quai et cette date dans le fichier importé. Vérifiez la date ou un autre quai.';renderTimetable(result);}catch(error){if(request===departureRequest)el('gtfs-status').textContent=error.message;}};
api('/api/info').then(info=>{el('gtfs-source').textContent=`Source : Nouvelle-Aquitaine Mobilités via PIGMA · ${info.counts.agency} réseaux déclarés · ${info.counts.stops.toLocaleString('fr-FR')} arrêts et quais · import du ${new Date(info.imported_at).toLocaleDateString('fr-FR')}. Couverture selon le fichier publié, sans garantie d’exhaustivité.`;}).catch(()=>{el('gtfs-status').textContent='Les horaires ne sont pas disponibles. Vérifiez que les données GTFS ont été incluses dans le déploiement.';});

function renderTimetable(result) {
  if (!result.departures.length) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'timetable-scroll';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Tableau des horaires, défilement horizontal possible');
  const table = document.createElement('table');
  table.className = 'timetable-table';
  const caption = table.createCaption();
  const selected = el('stop-choice').selectedOptions[0];
  caption.textContent = `${selected?.textContent || 'Arrêt sélectionné'} · ${result.date.split('-').reverse().join('/')} · horaires prévus`;
  const header = table.createTHead().insertRow();
  for (const label of ['Départ', 'Ligne', 'Direction', 'Réseau']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    header.append(cell);
  }
  const body = table.createTBody();
  for (const departure of result.departures) {
    const row = body.insertRow();
    const time = document.createElement('th');
    time.scope = 'row';
    time.textContent = departure.time;
    row.append(time);
    for (const value of [departure.route_short_name || departure.route_long_name || 'Non renseignée', departure.trip_headsign || 'Direction non renseignée', departure.agency_name || 'Réseau non renseigné']) {
      const cell = row.insertCell();
      cell.textContent = value;
    }
  }
  wrapper.append(table);
  el('gtfs-departures').append(wrapper);
}
// Clear stale results when a different platform or date is selected.
for (const id of ['stop-choice', 'gtfs-date', 'gtfs-time']) {
  el(id).addEventListener('change', () => {
    ++departureRequest;
    el('gtfs-departures').replaceChildren();
    el('gtfs-status').textContent = 'Cliquez sur « Afficher les départs » pour consulter les horaires de cette sélection.';
  });
}
