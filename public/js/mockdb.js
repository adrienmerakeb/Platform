// /js/mockdb.js — super-light client "DB" loader + a few helpers
export async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

export async function db() {
  // parallel load (tune as needed)
  const [hosts, queues, tours, promos, events, users] = await Promise.all([
    loadJson('/data/hosts.json'),
    loadJson('/data/queues.json'),
    loadJson('/data/tours.json'),
    loadJson('/data/promos.json'),
    loadJson('/data/events.json'),
    loadJson('/data/users.json'),
  ]);
  return { hosts: hosts.hosts, queues: queues.queues, tours: tours.tours, promos: promos.promos, events: events.events, users: users.users };
}

export const H = {
  byId: (hosts, id) => hosts.find(h => h.id === id),
  byQueueId: (hosts, qid) => hosts.find(h => h.queueId === qid),
};

export const Q = {
  byId: (queues, qid) => queues.find(q => q.queueId === qid),
};

export const geo = {
  haversineKm(lat1, lon1, lat2, lon2) {
    const R=6371, toRad=d=>d*Math.PI/180;
    const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },
  parseGps(gps) {
    if (!gps) return null;
    const [lat,lng] = gps.split(',').map(s=>parseFloat(s.trim()));
    return {lat, lng};
  }
};
