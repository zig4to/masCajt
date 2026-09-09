// Regression suite for the event-edit-prefill bug found 2026-08-21: opening
// the edit form for an already-created event left its fields blank.
//
// Runs against the REAL app (real index.html + skupni-koledar.jsx, served
// locally and rendered in a real headless browser) with the Supabase network
// calls intercepted and replaced by fixed fixtures, so it never touches the
// shared production calendar data. Two things happened in that Supabase
// table that make good fixtures: events created before per-day ids existed
// (empty id suffix on the storage key) and a duration stored with a plain
// hyphen instead of the current en-dash format -- both are reproduced below.
//
// Not run via `node --test` (which requires files to only use node:test's
// declarative API) because Playwright needs an async browser lifecycle
// around the whole suite; this is a plain script with its own pass/fail
// tally instead. Run with: npm run test:e2e

const path = require("path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { startServer } = require("./static-server.js");

const APP_ROOT = path.join(__dirname, "..", "..");

async function mockKvStore(page, rows) {
  await page.route("**/rest/v1/kv_store**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
  });
}

async function loginAsThrowawayUser(page, baseUrl) {
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="Ime"]', "Test");
  await page.fill('input[placeholder="Priimek"]', "Uporabnik");
  await page.click("text=Vstopi");
  await page.waitForTimeout(1000);
  // A fresh browser context has never been shown how to install the app, so
  // that screen stands between sign-in and the calendar these tests are for.
  const installHint = page.locator("text=Razumem");
  if (await installHint.count()) {
    await installHint.click();
    await page.waitForTimeout(800);
  }
}

// Day cards all start collapsed, so every test here has to open today before
// it can reach the event inside it.
//
// Reached through the day's own element rather than by its text. "Danes" is
// no longer unique on the page: the event strip names today's card that way
// too, and being the first match, the strip's copy is what a text locator
// finds. It is also animated, so Playwright waits for it to stop moving and
// never gets to click anything at all.
async function openToday(page) {
  await page.locator(`#day-${localToday()} button`).first().click();
  await page.waitForTimeout(300);
}

// The app builds today from the local clock. Taken from toISOString() instead,
// this ran an hour ahead or a day behind depending on the timezone: between
// local midnight and UTC midnight the fixtures landed on a day the calendar
// was no longer showing, and every test here failed looking for an event on a
// card that was not there. "sv-SE" is ISO order, formatted locally.
function localToday() {
  return new Intl.DateTimeFormat("sv-SE").format(new Date());
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eventRow(iso, idSuffix, value) {
  return { key: `avail:${iso}:__event__${idSuffix}`, value: JSON.stringify(value) };
}

const results = [];

async function runTest(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok - ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL - ${name}`);
    console.log(err.message);
  }
}

(async () => {
  const server = await startServer(APP_ROOT);
  const browser = await chromium.launch();

  try {
    await runTest("edit prefills fields for a normal, current-format event", async () => {
      const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
      const today = localToday();
      await mockKvStore(page, [
        eventRow(today, "111111", {
          title: "Test Dogodek",
          description: "Opis testa",
          duration: "18:00–20:00",
          createdBy: "Test Uporabnik",
          attendees: [],
        }),
      ]);
      await loginAsThrowawayUser(page, server.url);
      await openToday(page);
      await page.click('button[aria-label="Uredi dogodek"]');
      await page.waitForTimeout(300);

      assert.equal(await page.locator('input[placeholder="Ime dogodka"]').inputValue(), "Test Dogodek");
      assert.equal(await page.locator('input[aria-label="Začetek dogodka"]').inputValue(), "18:00");
      assert.equal(await page.locator('input[aria-label="Konec dogodka"]').inputValue(), "20:00");
      assert.equal(await page.locator('textarea[placeholder="Opis dogodka"]').inputValue(), "Opis testa");
      await page.close();
    });

    await runTest("edit prefills fields for a legacy event (empty id, hyphen duration)", async () => {
      // This is the exact shape of the real "Odbojka" row that triggered the
      // bug report: no id suffix on the key, and "20:00 - 22:00" instead of
      // "20:00–22:00".
      const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
      const today = localToday();
      await mockKvStore(page, [
        eventRow(today, "", {
          title: "Odbojka",
          description: "Poden",
          duration: "20:00 - 22:00",
          createdBy: "Test Uporabnik",
          attendees: ["Test Uporabnik"],
        }),
      ]);
      await loginAsThrowawayUser(page, server.url);
      await openToday(page);
      await page.click('button[aria-label="Uredi dogodek"]');
      await page.waitForTimeout(300);

      assert.equal(await page.locator('input[placeholder="Ime dogodka"]').inputValue(), "Odbojka");
      assert.equal(await page.locator('input[aria-label="Začetek dogodka"]').inputValue(), "20:00");
      assert.equal(await page.locator('input[aria-label="Konec dogodka"]').inputValue(), "22:00");
      assert.equal(await page.locator('textarea[placeholder="Opis dogodka"]').inputValue(), "Poden");
      await page.close();
    });

    await runTest("editing the second of two events on the same day loads the right one", async () => {
      const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
      const today = localToday();
      await mockKvStore(page, [
        eventRow(today, "111111", {
          title: "Prvi Dogodek",
          description: "",
          duration: "18:00–20:00",
          createdBy: "Test Uporabnik",
          attendees: [],
        }),
        eventRow(today, "222222", {
          title: "Drugi Dogodek",
          description: "",
          duration: "21:00–23:00",
          createdBy: "Test Uporabnik",
          attendees: [],
        }),
      ]);
      await loginAsThrowawayUser(page, server.url);
      await openToday(page);
      const editButtons = page.locator('button[aria-label="Uredi dogodek"]');
      assert.equal(await editButtons.count(), 2);
      await editButtons.nth(1).click();
      await page.waitForTimeout(300);

      assert.equal(await page.locator('input[placeholder="Ime dogodka"]').inputValue(), "Drugi Dogodek");
      await page.close();
    });

    await runTest("canceling a new-event draft doesn't leak into the next form opened", async () => {
      const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
      const today = localToday();
      await mockKvStore(page, [
        eventRow(today, "111111", {
          title: "Obstoječi",
          description: "",
          duration: "18:00–19:00",
          createdBy: "Test Uporabnik",
          attendees: [],
        }),
      ]);
      await loginAsThrowawayUser(page, server.url);
      await openToday(page);

      // Start a new event, type a draft title, then cancel without saving.
      // The "add another" button sits under the whole event stack now, the
      // same spot it has on a day with no events -- not on the card corner.
      await page.click("text=+ Dodaj dogodek");
      await page.waitForTimeout(200);
      await page.fill('input[placeholder="Ime dogodka"]', "Osnutek ki se ne shrani");
      await page.click("text=Prekliči");
      await page.waitForTimeout(200);

      // Now edit the existing event -- its real title must show, not the
      // canceled draft.
      await page.click('button[aria-label="Uredi dogodek"]');
      await page.waitForTimeout(200);
      assert.equal(await page.locator('input[placeholder="Ime dogodka"]').inputValue(), "Obstoječi");
      await page.close();
    });

    await runTest("share button in 'Več možnosti' copies a deep link to this event", async () => {
      const context = await browser.newContext({
        viewport: { width: 480, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const today = localToday();
      await mockKvStore(page, [
        eventRow(today, "111111", {
          title: "Deljeni Dogodek",
          description: "",
          duration: "18:00–20:00",
          createdBy: "Test Uporabnik",
          attendees: [],
        }),
      ]);
      await loginAsThrowawayUser(page, server.url);
      await openToday(page);
      await page.click('button[aria-label="Uredi dogodek"]');
      await page.waitForTimeout(300);
      await page.click("text=Več možnosti");
      await page.waitForTimeout(200);
      await page.click("text=Deli dogodek");

      // The button confirms in place...
      await page.waitForSelector("text=Kopirano", { timeout: 4000 });
      // ...and the clipboard holds a link straight back to this event, built
      // from wherever the app is served rather than a hard-coded host.
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(copied, `${server.url}/index.html#e=${today}:111111`);
      await context.close();
    });

    await runTest("opening a shared event link lands on that day, already expanded", async () => {
      const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
      const page = await context.newPage();
      const today = localToday();
      // A few days out, so the card sits well down the list -- only a working
      // scroll can bring it to the top, unlike today's card which is there
      // anyway.
      const target = addDays(today, 4);
      await mockKvStore(page, [
        eventRow(today, "aaaaaa", {
          title: "Danasnji", description: "", duration: "09:00–10:00",
          createdBy: "Test Uporabnik", attendees: [],
        }),
        eventRow(target, "111111", {
          title: "Dogodek Iz Povezave",
          description: "",
          duration: "18:00–20:00",
          createdBy: "Test Uporabnik",
          attendees: [],
        }),
      ]);
      // Sign in once so the name is in localStorage for this origin, then
      // arrive fresh on the shared link (the sign-in nav does not carry a hash).
      await loginAsThrowawayUser(page, server.url);
      // Via about:blank: navigating straight to the same path with only a hash
      // added is not a reload, so the app would never re-mount and the
      // auto-open effect would never run.
      await page.goto("about:blank");
      await page.goto(`${server.url}/index.html#e=${target}:111111`, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      const installHint = page.locator("text=Razumem");
      if (await installHint.count()) {
        await installHint.click();
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1500);

      // No day card was clicked here: the event's edit control only renders for
      // an expanded day, so its presence means the link opened the day itself.
      await page.waitForSelector('button[aria-label="Uredi dogodek"]', { timeout: 4000 });
      assert.ok(await page.locator("text=Dogodek Iz Povezave").count());

      // Regression: the auto-open effect used to fire while the "appLoader" was
      // still up, spending its one-shot scroll on a calendar not yet in the
      // DOM. The day would end up expanded but never pulled to the top -- so
      // assert the card actually sits near the top of the viewport.
      const cardTop = await page
        .locator(`#day-${target}`)
        .evaluate((el) => el.getBoundingClientRect().top);
      assert.ok(
        cardTop > -40 && cardTop < 140,
        `day card should be scrolled near the top, was at ${cardTop}px`
      );
      await context.close();
    });

    await runTest("'Deli sliko' renders a card snapshot into the preview sheet", async () => {
      const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
      const page = await context.newPage();
      const today = localToday();
      await mockKvStore(page, [
        eventRow(today, "111111", {
          title: "Piknik ob Savi",
          description: "Prinesite dobro voljo.",
          duration: "18:00–20:00",
          createdBy: "Test Uporabnik",
          attendees: ["Test Uporabnik"],
        }),
      ]);
      await loginAsThrowawayUser(page, server.url);
      await openToday(page);
      await page.click('button[aria-label="Uredi dogodek"]');
      await page.waitForTimeout(300);
      await page.click("text=Več možnosti");
      await page.waitForTimeout(200);
      await page.click("text=Deli sliko");

      // The sheet opens immediately with a "rendering" line, then swaps in the
      // generated image once modern-screenshot (loaded on demand from esm.sh)
      // has rasterised the off-screen card. Generous timeout: first run pays
      // for the dynamic import.
      await page.waitForSelector("text=Pripravljam sliko", { timeout: 4000 });
      const preview = page.locator('img[alt="Predogled slike dogodka"]');
      await preview.waitFor({ state: "visible", timeout: 20000 });
      const src = await preview.getAttribute("src");
      assert.ok(src && src.startsWith("blob:"), `preview src should be a blob url, got ${src}`);

      // The generated PNG really is a PNG.
      const isPng = await page.evaluate(async (u) => {
        const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
        return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      }, src);
      assert.ok(isPng, "preview blob should carry the PNG signature");

      // The off-screen snapshot card is a still of the plan: no comment toggle,
      // no "Potrdi udeležbo" prompt.
      const snapshotHtml = await page.evaluate(() => {
        const hidden = [...document.querySelectorAll('div[aria-hidden="true"]')].find(
          (d) => d.textContent.includes("Piknik ob Savi")
        );
        return hidden ? hidden.innerHTML : "";
      });
      assert.ok(snapshotHtml, "off-screen snapshot card should be mounted");
      assert.ok(!snapshotHtml.includes("Potrdi udeležbo"), "snapshot must not show the attend prompt");
      assert.ok(!/>\(\d+\)</.test(snapshotHtml), "snapshot must not show the comment count toggle");

      // Headless Chromium has no Web Share for files -- "Deli" must say so
      // inside the sheet, not fall through to a banner hidden behind it.
      await page.getByRole("button", { name: "Deli", exact: true }).click();
      await page.waitForSelector("text=Deljenje slike na tej napravi ni na voljo", {
        timeout: 3000,
      });

      await page.click("text=Zapri");
      await page.waitForTimeout(200);
      assert.equal(await preview.count(), 0, "preview sheet should close");
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
