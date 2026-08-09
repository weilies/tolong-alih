/**
 * Tolong Alih — asset worker.
 *
 * Static assets are served straight from ./public. The only thing this script
 * exists for is /config.js: the app is a single static HTML file with no build
 * step, so the per-environment values (which schema to talk to, which Supabase
 * project) have nowhere to be baked in. They live in wrangler vars and get
 * handed to the browser here.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/config.js") {
      // Cloudflare already resolved the request's country and city from the IP.
      // It costs nothing extra and covers the case the gate cares about most:
      // GPS refused or unavailable indoors, where we still need to know whether
      // the driver is in Malaysia.
      const cf = request.cf || {};
      const config = {
        env: env.APP_ENV,
        schema: env.APP_SCHEMA,
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        ip: {
          country: cf.country || null,
          city: cf.city || null,
          region: cf.region || null,
        },
      };
      return new Response(`window.__ENV=${JSON.stringify(config)};`, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
