const CACHE_NAME="analyse-acoustique-tgv-v1.0-b0611n";
const OPTIONAL_FILES=["./source/autotest-v099.js","./source/tgv-core-wasm-b64.js","./source/tgv-core-bridge.js","./source/tgv_core.wasm"];
const APP_FILES=["./","./index.html","./manifest.webmanifest","./source/AnalyseAcoustiqueTGV_v0.9.6_engine.js","./source/wav-decoder-v096.js","./source/wav-recorder-v096.js","./source/sessions-v096.js","./source/campbell-v096.js","./source/lecteur-v0910.js","./source/dominante-v098.js","./source/enquete-v099.js","./source/analyse-raie-v096.js","./source/carte-trajet-v096.js","./source/diametres-v097.js","./source/rapport-v097.js","./source/theme-v097.css","./source/interface-v0911.css","./source/ergonomie-v097.js","./source/mobile-v4.css","./source/affichage-v096.css","./source/affichage-v096.js","./source/mobile-v4.js","./source/ios-audio-m4a.js","./source/auto-save-acquisition.js","./vendor/maplibre-gl.js","./vendor/maplibre-gl.css","./icons/icon-192.png","./icons/icon-512.png","./icons/apple-touch-icon.png"];

// v0.9.6 b2910 : fichiers relus sur le serveur (jamais le cache HTTP) à l'installation
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(async cache=>{await cache.addAll(APP_FILES.map(url=>new Request(url,{cache:"reload"})));await Promise.all(OPTIONAL_FILES.map(url=>cache.add(new Request(url,{cache:"reload"})).catch(()=>{})));}));
  self.skipWaiting();
});

self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))));
  self.clients.claim();
});

// Réseau d'abord (version la plus récente quand le PC / serveur est joignable),
// copie locale en secours (utilisation sur le terrain, sans serveur).
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const requestUrl=new URL(event.request.url);
  if(requestUrl.pathname.startsWith("/tests_gros_fichiers/"))return; // fichiers d'essai (plusieurs centaines de Mo) : jamais mis en cache
  if(requestUrl.origin!==self.location.origin){
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(fetch(event.request,{cache:"no-store"}).then(response=>{
    if(response.ok){
      const copy=response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy)));
    }
    return response;
  }).catch(()=>caches.match(event.request,{ignoreSearch:true}).then(cached=>cached||(event.request.mode==="navigate"?caches.match("./index.html"):Response.error()))));
});
