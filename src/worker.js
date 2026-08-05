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
      const config = {
        env: env.APP_ENV,
        schema: env.APP_SCHEMA,
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
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
