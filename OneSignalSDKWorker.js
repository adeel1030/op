/* M A Products INDIA -- OMS service worker.
   One file does two jobs, because a page can have only ONE service worker:
     1. push notifications (OneSignal) -- the line below, exactly as before;
     2. ROUND 106 -- the app opens instantly and works without internet:
        the app page and its libraries are kept on the phone.
   How the app page is served:
     - normal open        -> the saved copy at once, and a fresh copy is
                             fetched quietly for next time;
     - "Update" button    -> (?_v=...) always fresh from the internet;
     - no saved copy yet  -> from the internet, then saved.
   Firebase data, logins, pushes, uploads: never touched here.
   KILL SWITCH: if the live page ever carries, in its first lines (put it
   right under the app-build meta), a meta tag named oms-sw with content off,
   this worker stops serving saved copies on every phone the next time the
   app is opened online (the push part keeps working). */
try{ importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); }catch(e){ /* push unavailable right now; the app cache still works */ }

const OMS_CACHE = 'oms-shell-v1';
const OMS_FLAGS = 'oms-flags-v1';
const OMS_PAGE_TIMEOUT_MS = 8000;
// Libraries the app loads from other sites. Every one is a fixed-version URL,
// so a saved copy can never be stale.
const OMS_CDN = [
  /^https:\/\/www\.gstatic\.com\/firebasejs\/\d+\.\d+\.\d+\//,
  /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[^/]+\/\d[^/]*\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/[^/]+@\d[^/]*\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@[^/]+\/[^/]+@\d[^/]*\//,
  /^https:\/\/fonts\.gstatic\.com\//,
];
// Changes now and then but fine to show a saved copy while refreshing it.
const OMS_SWR = [
  /^https:\/\/fonts\.googleapis\.com\/css2/,
  /^https:\/\/cdn\.onesignal\.com\/sdks\/web\/v16\/OneSignalSDK\.page\.js/,
];

function omsScope(){ return new URL(self.registration.scope); }
function omsPageKey(){ return omsScope().href; }           // one key for the app page, whatever the query
function omsIsAppPage(url){
  const s = omsScope();
  return url.origin === s.origin && (url.pathname === s.pathname || url.pathname === s.pathname + 'index.html');
}
async function omsKilled(){
  try{ const c = await caches.open(OMS_FLAGS); return !!(await c.match('/__oms_sw_off')); }catch(e){ return false; }
}
async function omsSetKilled(on){
  const c = await caches.open(OMS_FLAGS);
  if(on){ await c.put('/__oms_sw_off', new Response('off')); await caches.delete(OMS_CACHE); }
  else await c.delete('/__oms_sw_off');
}
function omsWithTimeout(p, ms){
  return Promise.race([p, new Promise((_, rej)=>setTimeout(()=>rej(new Error('timeout')), ms))]);
}
// Fetches of the app page can finish out of order (a slow quiet refresh from
// an earlier open landing after a newer one). Only the most recently STARTED
// fetch may decide what is saved and whether the switch is on.
let omsSeq = 0, omsApplied = 0;
// Save a fresh copy of the app page; also reads the kill switch from it.
async function omsStorePage(res, seq){
  if(!res || !res.ok || res.status !== 200 || res.type === 'opaque') return res;
  if(seq != null){ if(seq < omsApplied) return res; omsApplied = seq; }
  const text = await res.clone().text();
  if(!/name="app-build"/.test(text)) return res;              // not our page (an error page, a login wall)
  const off = /<meta\s+name="oms-sw"\s+content="off"/i.test(text.slice(0, 4096)); // only the top of the page, next to app-build -- never a mention further down
  await omsSetKilled(off);
  if(!off){
    const c = await caches.open(OMS_CACHE);
    await c.put(omsPageKey(), new Response(text, { status:200, headers:{ 'Content-Type':'text/html; charset=utf-8', 'X-OMS-Saved': String(Date.now()) } }));
  }
  return res;
}
async function omsFetchPageFresh(){
  const seq = ++omsSeq;
  const res = await fetch(omsPageKey(), { cache:'no-cache', credentials:'same-origin' });
  return omsStorePage(res, seq);
}
async function omsPage(event){
  const req = event.request;
  const url = new URL(req.url);
  if(await omsKilled()){
    // switched off: straight to the internet, but still look for "back on"
    const seq = ++omsSeq;
    const r = await fetch(req);
    event.waitUntil(omsStorePage(r.clone(), seq).catch(()=>{}));
    return r;
  }
  const c = await caches.open(OMS_CACHE);
  const saved = await c.match(omsPageKey());
  if(url.searchParams.has('_v') || !saved){
    // the Update button, or the very first open: the internet first
    try{
      const seq = ++omsSeq;
      const r = await omsWithTimeout(fetch(req.url, { cache:'no-store', credentials:'same-origin' }), OMS_PAGE_TIMEOUT_MS); // a navigate Request cannot be re-fetched with options
      await omsStorePage(r.clone(), seq);
      return r;
    }catch(e){
      if(saved) return saved;
      throw e;
    }
  }
  event.waitUntil(omsFetchPageFresh().catch(()=>{}));         // quietly, for next time
  return saved;
}
async function omsCacheFirst(event){
  const c = await caches.open(OMS_CACHE);
  const hit = await c.match(event.request);
  if(hit) return hit;
  const r = await fetch(event.request);
  if(r && (r.ok || r.type === 'opaque')){ const copy = r.clone(); event.waitUntil(omsKilled().then(k=>k ? null : c.put(event.request, copy)).catch(()=>{})); }
  return r;
}
async function omsStaleWhileRevalidate(event){
  const c = await caches.open(OMS_CACHE);
  const hit = await c.match(event.request);
  const net = fetch(event.request).then(r=>{ if(r && (r.ok || r.type === 'opaque')){ const copy = r.clone(); return omsKilled().then(k=>k ? null : c.put(event.request, copy)).then(()=>r, ()=>r); } return r; });
  if(hit){ event.waitUntil(net.catch(()=>{})); return hit; }
  return net;
}

self.addEventListener('install', event=>{
  self.skipWaiting();
  // Save the app page and the libraries it names, so the very next open is instant.
  event.waitUntil((async ()=>{
    try{
      const seq = ++omsSeq;
      const res = await omsWithTimeout(fetch(omsPageKey(), { cache:'no-cache' }), 15000);
      const text = await res.clone().text();
      await omsStorePage(res, seq);
      if(await omsKilled()) return;
      const urls = [...text.matchAll(/(?:src|href)="(https:\/\/[^"]+)"/g)].map(m=>m[1]).filter(u=>OMS_CDN.some(re=>re.test(u)) || OMS_SWR.some(re=>re.test(u)));
      const c = await caches.open(OMS_CACHE);
      await Promise.all(urls.map(u=>fetch(u, { mode: /fonts\.googleapis|onesignal/.test(u) ? 'cors' : 'no-cors' }).then(r=>{ if(r && (r.ok || r.type === 'opaque')) return c.put(u, r); }).catch(()=>{})));
    }catch(e){ /* no internet at install: it fills itself in on the next open */ }
  })());
});
self.addEventListener('activate', event=>{
  event.waitUntil((async ()=>{
    const keep = [OMS_CACHE, OMS_FLAGS];
    const names = await caches.keys();
    await Promise.all(names.filter(n=>/^oms-/.test(n) && !keep.includes(n)).map(n=>caches.delete(n)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event=>{
  const req = event.request;
  if(req.method !== 'GET') return;
  if(req.headers.has('range')) return;                         // the app's own "is there a new version?" check
  let url;
  try{ url = new URL(req.url); }catch(e){ return; }
  if(req.mode === 'navigate'){
    if(omsIsAppPage(url)) event.respondWith(omsPage(event));
    return;
  }
  if(OMS_CDN.some(re=>re.test(url.href))){ event.respondWith(omsKilled().then(k=>k ? fetch(req) : omsCacheFirst(event))); return; }
  if(OMS_SWR.some(re=>re.test(url.href))){ event.respondWith(omsKilled().then(k=>k ? fetch(req) : omsStaleWhileRevalidate(event))); return; }
  // same-site pictures / manifest next to the app (not the worker itself)
  const s = omsScope();
  if(url.origin === s.origin && url.pathname.startsWith(s.pathname) && /\.(png|jpe?g|svg|webp|ico|json)$/i.test(url.pathname)){
    event.respondWith(omsKilled().then(k=>k ? fetch(req) : omsStaleWhileRevalidate(event)));
  }
});
