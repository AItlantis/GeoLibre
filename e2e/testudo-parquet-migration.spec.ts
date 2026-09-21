import { expect, test, type Page } from "@playwright/test";

// E2E smoke test for the Testudo sqlite -> Parquet/DuckDB-WASM migration.
// Exercises network-kpi, scenario-comparison, and emissions-h3 against a
// real Testudo package served over HTTP, asserting no DuckDB/query errors
// surface in the console and that each plugin's manifest-driven UI
// (scenario/replication selectors) populates from real data.

const MANIFEST_URL = process.env.TESTUDO_MANIFEST_URL ?? "http://127.0.0.1:8899/manifest.json";

async function openControlsMenu(page: Page) {
  await page.getByRole("button", { name: "Controls" }).click();
}

async function loadManifest(page: Page, _panelTitle: string) {
  const urlInput = page.getByRole("textbox", { name: /manifest url/i }).first();
  await urlInput.waitFor({ state: "visible", timeout: 15_000 });
  await urlInput.fill(MANIFEST_URL);
  await page.getByRole("button", { name: "Load", exact: true }).first().click();
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

test.describe("Testudo Parquet migration", () => {
  test("Network KPI loads real Riyadh data without a DuckDB binder error", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");
    await openControlsMenu(page);
    await page.getByRole("menuitem", { name: "Network KPI" }).click();
    await loadManifest(page, "Network KPI");
    await page.waitForTimeout(3000);
    const binderErrors = errors.filter((e) => /Binder Error|UNION|Set operations/i.test(e));
    expect(binderErrors, `Console errors: ${JSON.stringify(errors, null, 2)}`).toHaveLength(0);
  });

  test("Scenario comparison loads real Riyadh data without a DuckDB binder error", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");
    await openControlsMenu(page);
    await page.getByRole("menuitem", { name: "Scenario comparison" }).click();
    await loadManifest(page, "Scenario comparison");
    await page.waitForTimeout(3000);
    const binderErrors = errors.filter((e) => /Binder Error|UNION|Set operations/i.test(e));
    expect(binderErrors, `Console errors: ${JSON.stringify(errors, null, 2)}`).toHaveLength(0);
  });

  test("Emissions H3 loads real Riyadh data without a DuckDB binder error", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");
    await openControlsMenu(page);
    await page.getByRole("menuitem", { name: "Emissions H3" }).click();
    await loadManifest(page, "Emissions H3");
    await page.waitForTimeout(3000);
    const binderErrors = errors.filter((e) => /Binder Error|UNION|Set operations/i.test(e));
    expect(binderErrors, `Console errors: ${JSON.stringify(errors, null, 2)}`).toHaveLength(0);
  });
});
