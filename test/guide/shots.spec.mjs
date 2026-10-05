import { test } from "@playwright/test";
import { fakeNeon, car } from "../smoke/fake-neon.mjs";

const OUT = new URL("../../public/guide/", import.meta.url).pathname;
const now = () => new Date().toISOString();
const shot = (el, name) => el.screenshot({ path: OUT + name, type: "jpeg", quality: 72 });
const BLOCK = "00000000-0000-0000-0000-0000000000b1";

async function app(page, opts) {
  const db = await fakeNeon(page, opts);
  await page.goto("/");
  await page.click("#askGeo");
  await page.locator("#app.on").waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById("toast").style.display = "none"; });
  return db;
}

test("sign up", async ({ page }) => {
  await fakeNeon(page, { signedIn: false });
  await page.goto("/");
  await page.click("#askGeo");
  await page.locator("#gAuth.on").waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById("toast").style.display = "none"; });
  // Top of the card: Google, email, password, phone, Create account
  const box = await page.locator("#gAuth .sign").boundingBox();
  const end = await page.locator("#signup").boundingBox();
  await page.screenshot({ path: OUT + "signup.jpg", type: "jpeg", quality: 72,
    clip: { x: box.x, y: box.y, width: box.width, height: end.y + end.height + 16 - box.y } });
});

test("garage", async ({ page }) => {
  await app(page, { cars: [] });
  await page.click('.tabs button[data-p="pG"]');
  await page.fill("#newPlate", "WXY 1234");
  await page.waitForTimeout(300);
  await shot(page.locator("#pG"), "garage-add.jpg");
  await page.click("#addCar");
  await page.waitForTimeout(800);
  await page.click('.tabs button[data-p="pG"]');
  await page.evaluate(() => { document.querySelector("nav.tabs").style.display = "none"; });
  await page.evaluate(() => { document.getElementById("toast").classList.remove("on"); });
  await page.waitForTimeout(300);
  await shot(page.locator("#pG"), "garage-done.jpg");
});

test("declare", async ({ page }) => {
  await app(page, { cars: [car("WXY 1234", "My Myvi")] });
  await page.fill("#v1", "ABC 987");
  await page.waitForTimeout(300);
  await shot(page.locator("#pD"), "declare.jpg");
});

test("alert", async ({ page }) => {
  await app(page, {
    cars: [car("ABC 987", "Wife's car")],
    blocks: [{ id: BLOCK, blocker_id: "someone", status: "open", blocker_plate_norm: "WXY1234" }],
    targets: [{ block_id: BLOCK, victim_plate_norm: "ABC987" }],
    messages: [{ id: "m1", block_id: BLOCK, from_label: "Blocked in", kind: "hot", is_typed: false,
      body: "WXY1234 is parked behind your ABC987. Driver says back in 15 min.", created_at: now(), from_user: null }],
  });
  await page.click('.tabs button[data-p="pI"]');
  await page.waitForTimeout(400);
  await shot(page.locator("#inbox .card").first(), "alert.jpg");
});

test("moved", async ({ page }) => {
  await app(page, {
    cars: [car("WXY 1234")],
    declared: [{ id: BLOCK, blocker_plate_norm: "WXY1234", eta_minutes: 15, status: "open",
      declared_at: now(), lat: 3.1, block_targets: [{ victim_plate_norm: "ABC987" }] }],
  });
  await page.evaluate(() => { document.querySelector("nav.tabs").style.display = "none"; });
  await page.locator("#mine .card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page.locator("#mine .card").first(), "moved.jpg");
});
