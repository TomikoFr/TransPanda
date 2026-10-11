// Same timetable queries as the Python API, using lazily loaded static files.
window.staticGTFS = (() => {
  const base = new URL('data/', document.baseURI);
  let stopsPromise, catalogPromise;
  async function load(file) {
    const response = await fetch(new URL(file, base));
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
      throw new Error('Les horaires ne sont pas encore publiés. Le déploiement doit inclure les données GTFS.');
    }
    return response.json();
  }
  const stops = () => stopsPromise ||= load('stops.json').catch(error => {stopsPromise = null; throw error;});
  const catalog = () => catalogPromise ||= load('catalog.json').catch(error => {catalogPromise = null; throw error;});
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
  function active(data, day) {
    const stamp = day.toISOString().slice(0,10).replaceAll('-', '');
    const weekday = (day.getUTCDay() + 6) % 7;
    const result = new Set(data.calendars.filter(c => c[1] <= stamp && c[2] >= stamp && c[3][weekday]).map(c => c[0]));
    for (const [service, kind] of data.exceptions[stamp] || []) {
      if (kind === 1) result.add(service); else if (kind === 2) result.delete(service);
    }
    return result;
  }
  return async path => {
    const url = new URL(path, document.baseURI);
    if (url.pathname.endsWith('/info')) return (await catalog()).info;
    if (url.pathname.endsWith('/routes')) {
      const term = normalize(url.searchParams.get('q') || '').trim();
      return (await catalog()).routes.filter(r => normalize(`${r.route_short_name} ${r.route_long_name} ${r.agency_name}`).includes(term)).sort((a,b) => Number(normalize(b.route_short_name)===term)-Number(normalize(a.route_short_name)===term) || a.route_short_name.localeCompare(b.route_short_name,'fr',{numeric:true})).slice(0,60);
    }
    if (url.pathname.endsWith('/stops')) {
      if (url.searchParams.get('all') === '1') return stops();
      if (url.searchParams.has('route')) {
        const mapping = await load('route-stops.json');
        const all = await stops();
        return (mapping[url.searchParams.get('route')] || []).map(i => all[i]).sort((a,b) => a.stop_name.localeCompare(b.stop_name,'fr'));
      }
      const term = normalize(url.searchParams.get('q') || '').trim();
      return term.length < 2 ? [] : (await stops()).filter(s => normalize(s.stop_name).includes(term)).slice(0,40);
    }
    const stop = (await stops()).find(s => s.stop_id === url.searchParams.get('stop'));
    if (!stop) throw new Error('Arrêt inconnu.');
    const date = url.searchParams.get('date');
    const day = new Date(`${date}T00:00:00Z`);
    const time = url.searchParams.get('time') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day.getTime()) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Date ou heure invalide.');
    const [h,m] = time.split(':').map(Number);
    const data = await catalog();
    const rows = data.departures_chunk_size
      ? (await load(`departures/${Math.floor(stop.file/data.departures_chunk_size)}.json`))[String(stop.file)] || []
      : await load(`departures/${stop.file}.json`);
    const departures = [];
    for (let offset=0; offset<3; offset++) {
      const serviceDay = new Date(day.getTime()-offset*86400000);
      const services = active(data,serviceDay);
      for (const [raw,service,route,headsign] of rows) {
        if (url.searchParams.has('route') && data.routes[route].route_id !== url.searchParams.get('route')) continue;
        const seconds = raw-offset*86400;
        if (services.has(service) && seconds>=h*3600+m*60 && seconds<86400) {
          departures.push({...data.routes[route],trip_headsign:headsign,seconds,time:`${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}`});
        }
      }
    }
    departures.sort((a,b) => a.seconds-b.seconds);
    return {departures:departures.slice(0,30),date,scheduled:true};
  };
})();
