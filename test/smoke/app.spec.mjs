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
