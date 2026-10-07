// A just-enough Neon Auth + Data API, answered inside the browser with
// page.route, so the smoke test drives the real app with no account or network.
// `state` is the database; tests read and change it.

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export async function fakeNeon(page, {
  signedIn = true, cars = [], phone = null, email = "driver@example.my", isAdmin = false,
  declared = [],   // blocks I have open (Declare tab)
  messages = [],   // my inbox (Alerts tab)
  blocks = [],     // blocks those messages belong to
  targets = [],    // block_targets rows I am party to
  threads = {},    // block id -> rows `thread()` returns (the history of a closed block)
  firstVisit = false, // true: this browser has never opened the app
  unverified = false, // true: password sign-in is refused, as Neon Auth does for an unverified email
} = {}) {
  if (!firstVisit) await page.addInitScript(() => localStorage.setItem("alih.seen", "1"));
  const state = { cars: [...cars], rpc: [], inserts: [] };
  const now = () => new Date().toISOString();
  const jwt = `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({
    sub: "u1", email, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`;

  // Fonts and anything else off-box: never leave the machine.
  await page.route(/^(?!http:\/\/localhost)/, (r) => r.abort());

  await page.route("**/api/auth/**", (r) => {
    if (unverified && /sign-in\/email/.test(r.request().url())) {
      return r.fulfill({ status: 403, contentType: "application/json",
        body: JSON.stringify({ message: "Email not verified", code: "EMAIL_NOT_VERIFIED" }) });
    }
    if (!signedIn) return r.fulfill({ status: 200, contentType: "application/json", body: "null" });
    return r.fulfill({
      status: 200, contentType: "application/json", headers: { "set-auth-jwt": jwt },
      body: JSON.stringify({
        session: { id: "s1", userId: "u1", token: "t", expiresAt: new Date(Date.now() + 864e5).toISOString(), createdAt: now(), updatedAt: now() },
        user: { id: "u1", email, name: "Test Driver", emailVerified: true, createdAt: now(), updatedAt: now() },
      }),
    });
  });

  await page.route("**/api/rest/**", async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/rest\//, "");
    const json = (body, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.startsWith("rpc/")) {
      state.rpc.push({ fn: path.slice(4), args: req.postDataJSON() });
      if (path === "rpc/thread") return json(threads[req.postDataJSON().p_block] || []);
      return json({ block_id: "00000000-0000-0000-0000-000000000001", notified: 1, ok: true });
    }
    if (path === "profiles" && req.method() === "GET") {
      return json({ phone, display_name: "Test Driver", avatar_url: null, is_admin: isAdmin });
    }
    if (path === "cars" && req.method() === "GET") return json(state.cars);
    if (path === "blocks" && req.method() === "GET") {
      if (url.searchParams.has("blocker_id")) return json(declared);
      // the History query asks for closed blocks only
      if ((url.searchParams.get("status") || "").includes("cleared")) {
        return json(blocks.filter((b) => b.status === "cleared" || b.status === "expired"));
      }
      return json(blocks);
    }
    if (path === "block_targets" && req.method() === "GET") return json(targets);
    if (path === "messages" && req.method() === "GET") return json(messages);
    if (path === "cars" && req.method() === "POST") {
      const row = req.postDataJSON();
      state.inserts.push(row);
      const plate = row.plate;
      state.cars.push({ id: `c${state.cars.length + 1}`, plate, plate_norm: plate.replace(/\s+/g, "").toUpperCase(), nickname: null });
      return r.fulfill({ status: 201, body: "" });
    }
    if (req.method() === "GET") return json([]);
    return r.fulfill({ status: 201, body: "" });
  });

  return state;
}

export function car(plate, nickname = null) {
  return { id: `c-${plate}`, plate, plate_norm: plate.replace(/\s+/g, "").toUpperCase(), nickname };
}
