/* Google Analytics for this app only: one GA4 property per Next Novas app, so one
   app's numbers are never mixed with another's. The measurement id comes from
   /config.js (wrangler var GA_MEASUREMENT_ID); empty means off, which is always
   the case on UAT, so test traffic never reaches the real numbers.

   Privacy choices, all stated in privacy.html:
   - Google's advertising features are off (no signals, no ad personalisation).
   - The cookie is host-only (this app's address), not shared across *.nextnovas.com.
   - Do Not Track and Global Privacy Control are respected.
   - Events never carry a plate, a name, an email or a position. */
(function(){
  "use strict";
  var id = window.__ENV && window.__ENV.ga;
  window.track = function(){};                       /* safe to call anywhere */
  if(!id || !/^G-[A-Z0-9]{6,14}$/.test(id)) return;
  if(navigator.doNotTrack === "1" || navigator.globalPrivacyControl) return;

  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  gtag("consent", "default", {
    analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied"
  });
  gtag("js", new Date());
  gtag("config", id, {
    cookie_domain: location.hostname,
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });
  window.track = function(name, params){ gtag("event", name, params || {}); };

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
  document.head.appendChild(s);
})();
