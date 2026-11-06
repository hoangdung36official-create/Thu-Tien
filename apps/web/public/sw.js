const CACHE='vincent-ui-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/','/icon.svg','/manifest.webmanifest'])));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',event=>{const req=event.request;if(req.method!=='GET'||new URL(req.url).pathname.startsWith('/api/'))return; if(req.mode==='navigate'){event.respondWith(fetch(req).catch(()=>caches.match('/')));return;}event.respondWith(fetch(req).catch(()=>caches.match(req)));});
