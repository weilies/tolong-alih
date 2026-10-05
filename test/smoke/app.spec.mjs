// Smoke test of the real pages, served by the real worker (serve.mjs), against
// a fake Neon (fake-neon.mjs). Catches the failures a no-build single-file app
// is prone to: a runtime error that blanks the page, a gate that never opens,
// a verb that stops calling its RPC.
import { test, expect } from "@playwright/test";
import { fakeNeon, car } from "./fake-neon.mjs";

// Any uncaught error, or console error other than the blocked off-box requests, fails the test.
test.beforeEach(async ({ page }, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  info.errors_ = errors;
});
test.afterEach(async ({}, info) => {
  expect(info.errors_, "no JavaScript errors on the page").toEqual([]);
});

async function signIn(page) {
  await page.goto("/");
  await page.click("#askGeo");
  await expect(page.locator("#app")).toHaveClass(/\bon\b/);
}

test("first load asks for location, and BM switches the copy", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/");
  await expect(page.locator("#gGeo")).toHaveClass(/\bon\b/);
  await expect(page.locator("#askGeo")).toHaveText("Turn on location");
  await page.click("#langBtn");
  await expect(page.locator("#askGeo")).toHaveText("Hidupkan lokasi");
});

test("location in Malaysia leads to sign-in when there is no session", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/");
  await page.click("#askGeo");
  await expect(page.locator("#gAuth")).toHaveClass(/\bon\b/);
  await expect(page.locator("#google")).toBeVisible();
  await expect(page.locator('#gAuth a[href="/terms.html"]')).toContainText("never sell your data");
});

test("a new driver with no car is guided to the Garage and back", async ({ page }) => {
  const db = await fakeNeon(page, { cars: [] });
  await signIn(page);

  await expect(page.locator("#pickCars")).toContainText("Add your car first");
  await expect(page.locator("#gNudge")).toBeVisible();
  await expect(page.locator("#declare")).toBeDisabled();

  await page.getByRole("button", { name: "Go to Garage" }).click();
  await expect(page.locator("#pG")).toHaveClass(/\bon\b/);
  await expect(page.locator("#newPlate")).toBeFocused();

  await page.fill("#newPlate", "wxy 1234");
  await page.click("#addCar");
  await expect(page.locator("#pD")).toHaveClass(/\bon\b/);
  await expect(page.locator("#gNudge")).toBeHidden();
  await expect(page.locator("#declare")).toBeEnabled();
  expect(db.inserts).toEqual([{ owner_id: "u1", plate: "WXY 1234", nickname: null }]);
});

test("declare sends the block to declare_block", async ({ page }) => {
  const db = await fakeNeon(page, { cars: [car("WXY 1234", "Myvi")] });
  await signIn(page);
  await expect(page.locator("#gNudge")).toBeHidden();
  // every refresh first sweeps blocks that ran out of time
  expect(db.rpc.map((c) => c.fn)).toContain("expire_blocks");

  await page.fill("#v1", "abc 987");
  await page.click("#declare");
  await expect.poll(() => db.rpc.map((c) => c.fn)).toContain("declare_block");
  const call = db.rpc.find((c) => c.fn === "declare_block");
  expect(call.args.p_victims).toEqual(["ABC 987"]);
  expect(call.args.p_eta).toBe(15);
});

for (const page_ of ["/about.html", "/admin.html"]) {
  test(`${page_} loads without errors`, async ({ page }) => {
    await fakeNeon(page, { signedIn: false });
    const res = await page.goto(page_);
    expect(res.status()).toBe(200);
    await page.waitForLoadState("networkidle");
  });
}

test("a first-time visitor lands on the explainer, and Start now opens the app", async ({ page }) => {
  await fakeNeon(page, { signedIn: false, firstVisit: true });
  await page.goto("/");
  await expect(page).toHaveURL(/\/start\.html$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Start now" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#gGeo")).toHaveClass(/\bon\b/);
  // second visit goes straight to the app
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
});

test("a first-time visitor who is already signed in is not sent to the explainer", async ({ page }) => {
  await fakeNeon(page, { firstVisit: true, cars: [car("WXY 1234")] });
  await page.goto("/");
  await page.click("#askGeo");
  await expect(page.locator("#app")).toHaveClass(/\bon\b/);
  await expect(page).toHaveURL(/\/$/);
});

// TA is the way home from every page, whatever is open.
for (const path of ["/start.html", "/about.html", "/terms.html", "/admin.html"]) {
  test(`${path}: TA goes home`, async ({ page }) => {
    await fakeNeon(page, { signedIn: false });
    await page.goto(path);
    const home = page.getByRole("link", { name: /Tolong Alih — home/ });
    await expect(home).toBeVisible();
    await home.click();
    await expect(page).toHaveURL(/\/$/);
  });
}

test("the footer shows the release the worker reports", async ({ page }) => {
  await fakeNeon(page, { cars: [car("WXY 1234")] });
  await signIn(page);
  await expect(page.locator("#ver")).toContainText("dev");
  await expect(page.locator("#dot")).toBeHidden();
});

test("Help shows the launch note when the worker has no stats yet", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/about.html");
  await page.getByText("Advertise with us").click();
  await expect(page.locator("#statsBlock")).toContainText("Just launched");
});

test("Help shows the figures once the worker has them", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.route("**/api/stats", (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ drivers: 900, plates: 1500, declared: 4000, resolved: 3100, mau: 1234 }),
  }));
  await page.goto("/about.html");
  await page.getByText("Advertise with us").click();
  await expect(page.locator("#statsBlock")).toContainText("1.2K");
  await expect(page.locator("#statsBlock")).toContainText("Plates registered");
});

test("every page has the same header and five-tab bar", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  for (const path of ["/start.html", "/about.html", "/terms.html", "/admin.html"]) {
    await page.goto(path);
    await expect(page.locator(".appbar .ta")).toHaveText("TA");
    await expect(page.locator(".tabbar .tx")).toHaveText(["Declare", "Trace", "Garage", "Help", "Contact"]);
    await expect(page.locator(".appbar .bell")).toHaveAttribute("href", "/#pI");
  }
  await page.goto("/start.html");
  await expect(page.locator('.tabbar a[aria-current="page"] .tx')).toHaveText("Help");
  await page.goto("/about.html");
  await expect(page.locator('.tabbar a[aria-current="page"] .tx')).toHaveText("Contact");
});

test("header and bottom bar stay put while a long page scrolls", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/terms.html");
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(150);
  const head = await page.locator(".appbar").boundingBox();
  const bar = await page.locator(".tabbar").boundingBox();
  const vh = page.viewportSize().height;
  expect(Math.round(head.y)).toBe(0);
  expect(Math.round(bar.y + bar.height)).toBe(vh);
});

test("in the app: bell instead of an Alerts tab, a red dot only while an alert is open", async ({ page }) => {
  const BLOCK = "00000000-0000-0000-0000-0000000000b1";
  const alert = {
    cars: [car("WXY 1234")],
    blocks: [{ id: BLOCK, blocker_id: "someone", status: "open", blocker_plate_norm: "ABC1234" }],
    targets: [{ block_id: BLOCK, victim_plate_norm: "WXY1234" }],
    messages: [{ id: "m1", block_id: BLOCK, from_label: "Blocked in", kind: "hot", is_typed: false,
      body: "ABC1234 is parked behind your WXY1234.", created_at: new Date().toISOString(), from_user: null }],
  };
  await fakeNeon(page, alert);
  await signIn(page);
  await expect(page.locator(".tabbar .tx")).toHaveText(["Declare", "Trace", "Garage", "Help", "Contact"]);
  await expect(page.locator("#dot")).toBeVisible();
  await page.locator("#bell").click();
  await expect(page.locator("#pI")).toHaveClass(/\bon\b/);
  await expect(page.locator("#inbox")).toContainText("ABC1234 is parked behind your WXY1234");
  // TA is home
  await page.getByRole("link", { name: /Tolong Alih — home/ }).click();
  await expect(page.locator("#pD")).toHaveClass(/\bon\b/);
});

test("the bell has no dot when nothing is waiting, and an expired block does not count", async ({ page }) => {
  const BLOCK = "00000000-0000-0000-0000-0000000000b1";
  await fakeNeon(page, {
    cars: [car("WXY 1234")],
    blocks: [{ id: BLOCK, blocker_id: "someone", status: "expired", blocker_plate_norm: "ABC1234" }],
    targets: [{ block_id: BLOCK, victim_plate_norm: "WXY1234" }],
    messages: [{ id: "m1", block_id: BLOCK, from_label: "Blocked in", kind: "hot", is_typed: false,
      body: "old", created_at: new Date().toISOString(), from_user: null }],
  });
  await signIn(page);
  await expect(page.locator("#dot")).toBeHidden();
});

test("the account menu has no language row, and the language toggle lives in the header", async ({ page }) => {
  await fakeNeon(page, { cars: [car("WXY 1234")] });
  await signIn(page);
  await expect(page.locator(".appbar #langBtn")).toBeVisible();
  await page.click("#avatarBtn");
  await expect(page.getByText("Bahasa Malaysia")).toHaveCount(0);
  await expect(page.getByText("Send me a test alert")).toHaveCount(0);
  await page.locator("#sheet").click({ position: { x: 5, y: 5 } });
  await page.click("#langBtn");
  await expect(page.locator(".tabbar .tx").first()).toHaveText("Isytihar");
  await expect(page.locator("footer .flinks a")).toHaveText(["Syarat penggunaan"]);
});

test("a bottom-bar link from another page opens that tab, even after signing in", async ({ page }) => {
  await fakeNeon(page, { cars: [car("WXY 1234")] });
  await signIn(page);
  await page.goto("/about.html");
  await page.locator(".tabbar a", { hasText: "Garage" }).click();
  await expect(page).toHaveURL(/#pG$/);
  await expect(page.locator("#pG")).toHaveClass(/\bon\b/);
  await expect(page.locator('.tabbar a[aria-current="page"] .tx')).toHaveText("Garage");
});

test("there is no phone number anywhere in sign-up, and a profile without one goes straight in", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/");
  await page.click("#askGeo");
  await expect(page.locator("#gAuth")).toHaveClass(/\bon\b/);
  await expect(page.locator("#phone, #phone2, #gPhone")).toHaveCount(0);
  await expect(page.locator("#gAuth")).not.toContainText(/phone/i);

  const ctx = await page.context().newPage();
  await fakeNeon(ctx, { cars: [car("WXY 1234")], phone: null });
  await ctx.goto("/");
  await ctx.click("#askGeo");
  await expect(ctx.locator("#app")).toHaveClass(/\bon\b/);
});

test("the ads console is offered only to the owner", async ({ page }) => {
  await fakeNeon(page, { cars: [car("WXY 1234")], isAdmin: true });            // an admin, but not the owner
  await signIn(page);
  await page.click("#avatarBtn");
  await expect(page.locator("#adminLink")).toBeHidden();

  const owner = await page.context().newPage();
  await fakeNeon(owner, { cars: [car("WXY 1234")], isAdmin: true, email: "weilies.chok@gmail.com" });
  await owner.goto("/");
  await owner.click("#askGeo");
  await expect(owner.locator("#app")).toHaveClass(/\bon\b/);
  await owner.click("#avatarBtn");
  await expect(owner.locator("#adminLink")).toBeVisible();

  const notOwner = await page.context().newPage();
  await fakeNeon(notOwner, { isAdmin: true });
  await notOwner.goto("/admin.html");
  await expect(notOwner.getByText("owner only")).toBeVisible();
});

test("the terms page makes the promise and switches to BM", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/terms.html");
  await expect(page.getByText("We never sell your data.")).toBeVisible();
  await expect(page.getByText(/We don't ask for your phone number/)).toBeVisible();
  await page.click("#langBtn");
  await expect(page.getByText("Kami tidak pernah menjual data anda.")).toBeVisible();
});

test("contact page: topics start closed, open one at a time, and deep links open the right one", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/about.html");
  const topics = page.locator("details.topic");
  await expect(topics).toHaveCount(5);
  await expect(page.locator("details.topic[open]")).toHaveCount(0);
  await page.locator("#t-report > summary").click();
  await page.locator("#t-ads > summary").click();
  await expect(page.locator("details.topic[open]")).toHaveCount(1);
  await expect(page.locator("#t-ads")).toHaveAttribute("open", "");

  await page.goto("/about.html#plate-ABC1234");
  await page.reload();
  await expect(page.locator("#t-plate")).toHaveAttribute("open", "");
  expect(decodeURIComponent(await page.locator("#waPlate").getAttribute("href"))).toContain("ABC1234");

  await page.goto("/about.html#delete");
  await page.reload();
  await expect(page.locator("#t-delete")).toHaveAttribute("open", "");
  expect(await page.locator("#mailDelete").getAttribute("href")).toMatch(/^mailto:/);
  await expect(page.locator("#waDelete")).toHaveCount(0);

  await page.click("#langBtn");
  await expect(page.getByRole("heading", { name: "Hubungi kami" })).toBeVisible();
});
