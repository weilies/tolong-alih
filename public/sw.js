/* Tolong Alih — service worker. Push only: no caching, no offline mode, so a
   deploy is never stuck behind a stale copy of the app.

   The worker (src/push.js) sends { title, body, tag, kind, url }. Every push
   must show a notification — iOS revokes the subscription of a site that
   receives pushes silently. */

self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function(e){
  var d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { body: e.data && e.data.text() }; }

  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Tolong Alih", {
      body: d.body || "Something changed on one of your blocks.",
      tag: d.tag || "alih",
      renotify: true,
      requireInteraction: d.kind === "hot",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: d.url || "/" }
    }),
    /* An open tab refreshes now instead of on its next 45s poll. */
    self.clients.matchAll({ type: "window" }).then(function(list){
      list.forEach(function(c){ c.postMessage({ type: "push" }); });
    })
  ]));
});

self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
    for(var i = 0; i < list.length; i++){
      if(list[i].url.indexOf(self.location.origin) === 0 && "focus" in list[i]){
        list[i].postMessage({ type: "open-alerts" });
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url + (url.indexOf("?") < 0 ? "?" : "&") + "tab=alerts");
  }));
});
