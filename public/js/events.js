// /js/events.js
import { initMap, addMarker } from '/js/map.js';

export async function loadEvents() {
  const res = await fetch('/data/events.json?_=' + Date.now());
  return await res.json();
}

export function filterEvents(list, { scope='public', time='now', center=[14.42076,50.08804], maxKm=50 }) {
  const now = Date.now();
  const toKm = (a,b)=>{
    const [lng1,lat1]=a,[lng2,lat2]=b, R=6371;
    const dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
    const s=Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  };
  return list.filter(e=>{
    // scope
    if (scope==='public' && e.visibility!=='public') return false;
    if (scope==='my' && !e.isMine) return false;       // set isMine client-side from user state
    if (scope==='following' && !e.isFollowing) return false;
    // time
    const starts = e.starts_at ? Date.parse(e.starts_at) : null;
    const ends   = e.ends_at ? Date.parse(e.ends_at) : null;
    const isPermanent = !!e.permanent;
    const active = isPermanent || (starts && starts<=now && (!ends || ends>=now));
    const upcoming = starts && starts>now;
    if (time==='now' && !active) return false;
    if (time==='upcoming' && !upcoming) return false;
    if (time==='permanent' && !isPermanent) return false;
    // distance
    const km = toKm(center, [e.location.lng, e.location.lat]);
    return km <= maxKm;
  });
}

export async function renderEventsOnMap(mapId, options) {
  const map = await initMap(mapId, { zoom: 13 });
  const user = getUser(); // mock
  const events = (await loadEvents()).map(e => ({
    ...e,
    isMine: user && e.creator_id === user.id,
    isFollowing: user && (e.members||[]).includes(user.id)
  }));
  const filtered = filterEvents(events, options||{});
  filtered.forEach(e => {
    const label = `${e.title} — ${e.permanent ? 'permanent' : (e.starts_at || '')}`;
    const color = e.visibility==='public' ? '#1E88E5' : (e.isMine ? '#43A047' : '#FBC02D');
    addMarker(map, e.location.lng, e.location.lat, label, color);
  });
}

function getUser(){  // stubbed user
  try { return JSON.parse(localStorage.getItem('demo_user')) || { id:'u_demo' }; }
  catch { return { id:'u_demo' }; }
}

// --- Chat (localStorage MVP) ---
export const Chat = {
  send(chatId, userId, text){
    const key = 'chat_'+chatId;
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.push({ userId, text, at: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(arr));
    return arr;
  },
  list(chatId){
    const key = 'chat_'+chatId;
    return JSON.parse(localStorage.getItem(key) || '[]');
  }
};
