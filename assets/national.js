// National source discovery. The timetable panel retains its imported NA coverage.
const directory = document.createElement('section');
directory.className = 'results';
directory.id = 'reseaux-france';
directory.innerHTML = `<div class="results-title"><div><span class="eyebrow">EXPLORER LES SOURCES OFFICIELLES</span><h2>Les réseaux de toute la France</h2></div><span class="demo-tag">ANNUAIRE NATIONAL</span></div><p>Cherchez un réseau, une ville ou un territoire pour consulter son jeu de données officiel. Cet annuaire ne signifie pas que ses horaires sont intégrés : le tableau ci-dessus couvre encore la Nouvelle-Aquitaine.</p><label for="network-query">VILLE, TERRITOIRE OU RÉSEAU</label><div class="field"><input type="search" id="network-query" placeholder="Ex. Lyon, Île-de-France, SNCF…" disabled></div><p id="network-status" role="status" aria-live="polite">Chargement du catalogue national…</p><div id="network-results" class="network-grid"></div><button type="button" id="more-networks" hidden>Afficher plus de réseaux</button>`;
document.getElementById('horaires').after(directory);
let nationalNetworks = [], limit = 12;
const normalized = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr');
function renderNetworks() {
  const term = normalized(document.getElementById('network-query').value.trim());
  const matches = nationalNetworks.filter(n => normalized([n.title,n.publisher,...n.areas].join(' ')).includes(term));
  const container = document.getElementById('network-results');
  container.replaceChildren();
  for (const network of matches.slice(0,limit)) {
    const card = document.createElement('article');card.className='card';
    const title=document.createElement('h3');title.textContent=network.title;
    const area=document.createElement('p');area.textContent=network.areas.join(' · ') || 'Territoire non renseigné';
    const link=document.createElement('a');link.textContent='Consulter la source officielle ↗';link.href=network.url;link.target='_blank';link.rel='noopener noreferrer';
    card.append(title,area,link);container.append(card);
  }
  document.getElementById('network-status').textContent=`${matches.length} jeux de données disponibles · ${Math.min(limit,matches.length)} affichés. Horaires nationaux non encore intégrés.`;
  document.getElementById('more-networks').hidden=matches.length<=limit;
}
document.getElementById('network-query').oninput=()=>{limit=12;renderNetworks();};
document.getElementById('more-networks').onclick=()=>{limit+=12;renderNetworks();};
fetch(new URL('data/national-networks.json',document.baseURI)).then(async response=>{
  if(!response.ok)throw new Error();
  const data=await response.json();nationalNetworks=data.networks;
  document.getElementById('network-query').disabled=false;renderNetworks();
}).catch(()=>{document.getElementById('network-status').textContent='Le catalogue national sera disponible après sa génération et son déploiement.';});
