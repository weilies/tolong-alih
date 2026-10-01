// Serves public/ through the real src/worker.js on localhost, so the smoke test
// exercises the same routing as Cloudflare (config.js, /api proxies) with no
// wrangler, account or network. The Neon URLs are placeholders: the browser
// test intercepts /api/* before anything leaves the machine.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../../src/worker.js";

const PUBLIC = new URL("../../public/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json",
};

const ASSETS = {
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC)) return new Response("no", { status: 403 });
    try {
      return new Response(await readFile(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

const env = {
  APP_ENV: "test",
  NEON_AUTH_URL: "http://127.0.0.1:9/auth",
  NEON_DATA_API_URL: "http://127.0.0.1:9/rest",
  ASSETS,
};

const port = Number(process.env.PORT || 8788);
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method, headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const out = await worker.fetch(request, env, { waitUntil() {} });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log(`smoke server on http://localhost:${port}`));
