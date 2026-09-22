---
name: geolibre-plugin-screenshot
description: "Open a GeoLibre plugin, load a manifest, start playback, and capture a rendered screenshot."
---

# GeoLibre Plugin Screenshot

Use this skill when the user asks to visually exercise a GeoLibre plugin with a manifest and produce a screenshot.

## Workflow

1. Confirm the GeoLibre Vite app is running. If it is not, start it from the repository with:

   ```powershell
   corepack pnpm --filter geolibre-desktop exec vite
   ```

2. Use a real Chromium/Chrome browser through Playwright. Prefer the installed Chrome executable when Playwright's bundled browser is unavailable.

3. Open `http://127.0.0.1:5173/`, click `Plugins`, and select the requested plugin.

4. In the plugin's own dialog/panel, fill the manifest URL input with the user-supplied URL. Scope the `Load` button to that dialog; the app may have other hidden or background `Load` buttons.

5. Click `Load`, wait for the manifest/data to render, then start playback using the plugin's playback control. For plugins without a playback control, leave the loaded rendered state visible and report that playback is not applicable.

6. Capture a screenshot at approximately 1600×1000 into:

   ```text
   test-results/plugin-screenshots/<plugin-id>.png
   ```

   Use a fresh browser page per plugin so previously opened panels do not contaminate the screenshot.

7. Capture browser `error`, `pageerror`, and failed-request events during the workflow. Do not claim success if the plugin panel is visible but data failed to load or playback did not start.

## Plugin handling

- Vehicle Playback: load the animation manifest, wait for chunk coverage, then press the play control and capture vehicles in motion when possible.
- Network KPI, Path Analysis, Scenario Comparison, and Emissions H3: load the supplied manifest if the schema supports the plugin, then activate the plugin's render/playback control. If the manifest is incompatible, capture the panel only and report the schema mismatch.

Always return clickable absolute file links to the generated screenshots and summarize any remaining browser warnings separately from errors.
