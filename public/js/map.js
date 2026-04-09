// Map helper that lazy-loads MapLibre and provides init + markers
export async function ensureMapLibre(){
  if (window.maplibregl) return;
  await new Promise(r => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/maplibre-gl@3.6.1/dist/maplibre-gl.js';
    s.onload = r; document.head.appendChild(s);
  });
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://unpkg.com/maplibre-gl@3.6.1/dist/maplibre-gl.css';
  document.head.appendChild(l);
}
export async function initMap(id, opts = {}){
  await ensureMapLibre();
  const map = new maplibregl.Map({
    container: id,
    style: 'https://demotiles.maplibre.org/style.json',
    center: opts.center || [14.42076, 50.08804],
    zoom: opts.zoom || 12
  });
  // Only add controls if explicitly enabled
  if (opts.controls) {
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
  }
  return map;
}

export function addMarker(map, lng, lat, label, color = '#1E88E5'){
  const el = document.createElement('div');
  el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};box-shadow:0 0 0 3px rgba(0,0,0,.12)`;
  new maplibregl.Marker(el).setLngLat([lng, lat]).setPopup(new maplibregl.Popup().setText(label || '')).addTo(map);
}

