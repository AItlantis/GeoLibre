const CONTROL_IDS = new Set([
  "navigation", "fullscreen", "geolocate", "globe", "terrain", "scale",
  "attribution", "logo", "maptoolkit-logo", "layer-control",
]);
const PLAYBACK_COMMANDS = new Set([
  "testudoSetPlaybackPlaying", "testudoRestartPlayback", "testudoSeekPlayback",
  "testudoSetPlaybackSpeed",
]);
const SUPPORTED_COMMANDS = new Set([
  "testudoGetState", "testudoGetCameraState", "testudoSetCamera",
  "testudoGetMapControlState", "testudoSetBuiltInMapControl",
  "testudoGetPlaybackState", "testudoGetProgressState", "testudoGetScenarioState", "testudoSelectScenario", "testudoSetGuestCapability",
  "testudoGetGeoAiStatus", "testudoGetOllayaScenarioStatus", "testudoRequestInvestigation", "testudoLoadPackage", "testudoOpenGeoAiChat", ...PLAYBACK_COMMANDS,
]);
const CHAT_PANEL_ID = "testudo-geoai-chat";
let cleanupActivePlugin = null;

function finiteIn(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validCamera(payload) {
  const keys = Object.keys(payload ?? {});
  if (!keys.some((key) => key !== "challenge") ||
      keys.some((key) => !["challenge", "center", "zoom", "bearing", "pitch"].includes(key))) return false;
  if (payload.center !== undefined && !(Array.isArray(payload.center) && payload.center.length === 2 &&
      finiteIn(payload.center[0], -180, 180) && finiteIn(payload.center[1], -90, 90))) return false;
  return (payload.zoom === undefined || finiteIn(payload.zoom, 0, 24)) &&
      (payload.bearing === undefined || finiteIn(payload.bearing, -180, 180)) &&
      (payload.pitch === undefined || finiteIn(payload.pitch, 0, 85));
}

function getCamera(app) {
  const map = app.getMap?.();
  if (!map) return { available: false, reason: "The active renderer does not expose a MapLibre camera." };
  const center = map.getCenter();
  return {
    available: true,
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
}

function getMapControlState(app) {
  const controls = {};
  for (const id of CONTROL_IDS) controls[id] = app.getBuiltInMapControlVisible?.(id) ?? false;
  return {
    renderer: app.getMapRenderer?.() ?? "unknown",
    controls,
  };
}

function compactInvestigationSummary(reply, raw, ollaya) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const scalar = (value) => typeof value === "string" && value.length > 0
    ? value.slice(0, 128)
    : typeof value === "number" && Number.isFinite(value) ? value : null;
  const boundedTopSections = (rank) => {
    const sections = Array.isArray(rank?.sections) ? rank.sections.slice(0, 3) : [];
    return sections.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const sectionId = scalar(item.section_id);
      if (sectionId === null) return [];
      const metrics = {};
      if (item.metrics && typeof item.metrics === "object" && !Array.isArray(item.metrics)) {
        for (const [name, value] of Object.entries(item.metrics).slice(0, 4)) {
          if (/^[a-z0-9_ -]{1,64}$/i.test(name) && (typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 128)) metrics[name] = value;
        }
      }
      return [{ sectionId, score: Number.isFinite(item.score) ? item.score : null, metrics }];
    });
  };
  const gaps = Array.isArray(record.evidence_gaps)
    ? record.evidence_gaps.filter((value) => typeof value === "string").slice(0, 8).map((value) => value.slice(0, 240))
    : [];
  if (!raw || typeof raw !== "object") gaps.push("Structured scenario evidence was not returned.");
  const summary = {
    reply: reply.slice(0, 1200),
    selectedScenario: null,
    currentTopSections: boundedTopSections(record.current_severity),
    worseningTopSections: boundedTopSections(record.worsening_vs_baseline),
    evidenceGaps: gaps.slice(0, 8),
  };
  if (ollaya && typeof ollaya === "object") {
    const compact = {};
    for (const key of ["status", "intent", "code", "analysis_profile", "analysis_profile_status", "scenario_type_suggestion", "scenario_type_status"]) if (typeof ollaya[key] === "string") compact[key] = ollaya[key].slice(0, 160);
    for (const key of ["available", "classified"]) if (typeof ollaya[key] === "boolean") compact[key] = ollaya[key];
    for (const key of ["analysis_profile_confidence", "scenario_type_confidence"]) if (Number.isFinite(ollaya[key])) compact[key] = ollaya[key];
    if (Object.keys(compact).length) summary.ollaya = compact;
  }
  const scenario = record.scenario && typeof record.scenario === "object" ? record.scenario : {};
  const scenarioId = scalar(scenario.scenario_id ?? record.selected_scenario_id);
  if (scenarioId !== null) {
    const name = scalar(scenario.name ?? scenario.label ?? scenario.scenario_name);
    summary.selectedScenario = { id: scenarioId, ...(name ? { name } : {}) };
  }
  for (const key of ["status", "reason", "match_method", "score_label", "score_calibration_status"]) if (typeof record[key] === "string") summary[key] = record[key].slice(0, 160);
  for (const key of ["model_match_score", "matching_threshold", "matching_margin"]) if (Number.isFinite(record[key])) summary[key] = record[key];
  if (record.analysis_profile && typeof record.analysis_profile === "object") {
    const profile = {};
    for (const key of ["selected", "source", "reason"]) if (typeof record.analysis_profile[key] === "string") profile[key] = record.analysis_profile[key].slice(0, 160);
    if (Object.keys(profile).length) summary.analysis_profile = profile;
  }
  if (record.viewer_action && typeof record.viewer_action === "object" && record.viewer_action.source === "server_catalog") {
    summary.viewer_action = { source: "server_catalog" };
    for (const key of ["scenario_id", "section_id", "version_id"]) {
      const value = scalar(record.viewer_action[key]);
      if (value !== null) summary.viewer_action[key] = value;
    }
  }
  const impact = record.subpath_impact;
  if (impact && typeof impact === "object" && Array.isArray(impact.paths)) {
    const paths = impact.paths.slice(0, 3).flatMap((path) => {
      if (!path || typeof path !== "object" || !Array.isArray(path.journey_times)) return [];
      const journey_times = path.journey_times.slice(0, 8).flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const compact = {};
        for (const key of ["interval_id", "baseline_interval_id", "time_window", "current", "baseline"]) {
          const value = row[key];
          if (typeof value === "string" && value.length <= 160 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") compact[key] = value;
          else if ((key === "current" || key === "baseline") && value && typeof value === "object") {
            const nested = {};
            for (const field of ["journey_time", "value", "count", "unit"]) {
              const fieldValue = value[field];
              if (typeof fieldValue === "string" && fieldValue.length <= 160 || typeof fieldValue === "number" && Number.isFinite(fieldValue)) nested[field] = fieldValue;
            }
            if (Object.keys(nested).length) compact[key] = nested;
          }
        }
        for (const key of ["delta", "percentage_delta"]) if (Number.isFinite(row[key])) compact[key] = row[key];
        if (typeof row.comparable === "boolean") compact.comparable = row.comparable;
        return Object.keys(compact).length ? [compact] : [];
      });
      if (!journey_times.length) return [];
      const compact = { journey_times };
      for (const key of ["origin", "destination", "vehicle"]) {
        const value = scalar(path[key]); if (value !== null) compact[key] = value;
      }
      if (Array.isArray(path.section_ids)) compact.section_ids = path.section_ids.slice(0, 16).flatMap((value) => { const id = scalar(value); return id === null ? [] : [id]; });
      return [compact];
    });
    if (paths.length) {
      summary.subpath_impact = { paths };
      for (const key of ["comparable_interval_count", "expected_baseline_comparisons"]) if (Number.isSafeInteger(impact[key]) && impact[key] >= 0) summary.subpath_impact[key] = impact[key];
      if (Number.isFinite(impact.baseline_comparison_coverage) && impact.baseline_comparison_coverage >= 0 && impact.baseline_comparison_coverage <= 1) summary.subpath_impact.baseline_comparison_coverage = impact.baseline_comparison_coverage;
    }
  }
  const od = record.od_evidence;
  if (od && typeof od === "object") {
    const compact = {};
    for (const key of ["status", "comparison", "metric", "reason", "source_table"]) if (typeof od[key] === "string") compact[key] = od[key].slice(0, 160);
    if (od.capabilities && typeof od.capabilities === "object") compact.capabilities = Object.fromEntries(Object.entries(od.capabilities).slice(0, 12).flatMap(([key, value]) => /^[a-z0-9_]{1,64}$/i.test(key) && typeof value === "boolean" ? [[key, value]] : []));
    if (Object.keys(compact).length) summary.od_evidence = compact;
  }
  const assignments = record.route_assignment_evidence;
  if (assignments && typeof assignments === "object") summary.route_assignment_evidence = {
    assigned_demand_only: true,
    ...(typeof assignments.status === "string" ? { status: assignments.status.slice(0, 160) } : {}),
    ...(typeof assignments.reason === "string" ? { reason: assignments.reason.slice(0, 240) } : {}),
  };
  return summary;
}

export const plugin = {
  id: "testudo-bridge",
  name: "Testudo iframe bridge",
  version: "0.1.0",
  engines: ["maplibre"],
  activate(app) {
    const parent = window.parent;
    if (parent === window) return;
    const allowedOrigins = (app.getEmbedAllowedOrigins?.() ?? []).filter((origin) => origin !== "*");
    if (allowedOrigins.length === 0) return;

    const challenge = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (value) => value.toString(16).padStart(2, "0")).join("");
    let parentOrigin = null;
    let guestCredential = null;
    let principalCredential = null;
    let packageBinding = null;
    let chatTurns = [];
    let unregisterChatPanel = null;
    let chatPanelElements = null;
    let unsubscribeFeatures = null;
    let disposed = false;
    const send = (type, payload, target = parentOrigin) => {
      if (!disposed && target && allowedOrigins.includes(target)) {
        parent.postMessage({ v: 2, source: "geolibre", type, payload }, target);
      }
    };
    const ready = () => {
      if (!disposed) parent.postMessage({
        v: 2, source: "geolibre", type: "ready",
        payload: { version: "testudo-v1", challenge },
      }, "*");
    };
    const sharedSnapshot = () => app.sharedFeatures?.getSnapshot?.() ?? {};
    const playbackState = () => {
      const playback = sharedSnapshot().playback;
      return playback?.available === true
        ? { ...playback, loading: false }
        : { available: false, loading: false, playing: false, tick: 0, maxTick: 0, speed: 1, dt: 0, loop: false };
    };
    const progressState = () => sharedSnapshot().progress?.available === true
      ? sharedSnapshot().progress
      : { available: false, reason: "No active plugin provides measured package loading progress." };
    const state = () => ({
      status: "ready",
      selectedPlugin: null,
      selectedMode: null,
      capabilities: {
        camera: Boolean(app.getMap?.()),
        mapControls: Boolean(app.getBuiltInMapControlVisible),
        playback: playbackState().available,
        measuredProgress: progressState().available,
        scenarioSelection: sharedSnapshot().scenario?.available === true,
        geoai: Boolean((guestCredential && guestCredential.expiresAt > Date.now()) || principalCredential),
        ollayaScenarioMatching: Boolean((guestCredential && guestCredential.expiresAt > Date.now()) || principalCredential),
      },
      map: getMapControlState(app),
    });
    const submitChat = async (question, requestId) => {
      if ((!guestCredential || guestCredential.expiresAt <= Date.now()) && !principalCredential) throw new Error("A Testudo signed-in or guest capability is required for GeoAI chat.");
      const timeout = new AbortController();
      const timeoutId = window.setTimeout(() => timeout.abort(new DOMException("GeoAI request timed out.", "TimeoutError")), 90_000);
      try {
        const bounds = app.getViewBounds?.();
        const viewerContext = {
          surface: "geolibre",
          map: { available: Boolean(app.getMap?.()) },
          ...(packageBinding?.packageId ? { package_id: packageBinding.packageId } : {}),
          ...(packageBinding?.packageVersionId ? { package_version_id: packageBinding.packageVersionId } : {}),
          ...(bounds && bounds.length === 4 && bounds.every(Number.isFinite) ? { camera_bounds: bounds } : {}),
        };
        const previous = chatTurns.slice(-10).filter((turn) => turn.role === "user" || turn.role === "assistant");
        const signedIn = Boolean(principalCredential);
        const response = await fetch(new URL(signedIn ? "/api/v1/ai/chat" : "/api/public/demo/geoai-chat", parentOrigin), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: signedIn ? `Bearer ${principalCredential.bearerToken}` : `Testudo-Embed ${guestCredential.token}` },
          body: JSON.stringify({ prompt: question.trim().slice(0, 4000), messages: previous, viewer_context: viewerContext, ...(signedIn ? { package_id: packageBinding.packageId, package_version_id: packageBinding.packageVersionId } : {}) }),
          credentials: "omit", cache: "no-store", redirect: "error", signal: timeout.signal,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((result && (result.error || result.detail)) || `Testudo chat request failed (${response.status}).`);
        if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error(result.code || "Testudo AI did not return a response.");
        const userQuestion = question.trim().slice(0, 2000);
        chatTurns = [...previous, { role: "user", content: userQuestion }, { role: "assistant", content: result.reply.slice(0, 2000) }].slice(-10);
        const summary = compactInvestigationSummary(result.reply, result.scenario_analysis, result.ollaya);
        if (chatPanelElements) {
          const replyNode = chatPanelElements.transcript.ownerDocument.createElement("p");
          replyNode.textContent = `Testudo: ${result.reply.slice(0, 2000)}`;
          chatPanelElements.transcript.append(replyNode);
          chatPanelElements.status.textContent = "Testudo replied.";
        }
        send("testudoGeoAiInvestigationUpdate", { requestId, question: userQuestion, status: "complete", summary });
        return summary;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        if (chatPanelElements) chatPanelElements.status.textContent = message;
        send("testudoGeoAiInvestigationUpdate", { requestId, question: question.trim().slice(0, 4000), status: "error", error: message });
        throw error;
      } finally { window.clearTimeout(timeoutId); }
    };
    const onMessage = async (event) => {
      const request = event.data;
      if (event.source !== parent || !allowedOrigins.includes(event.origin) ||
          request?.v !== 2 || request.source !== "testudo" ||
          typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 200 ||
          !SUPPORTED_COMMANDS.has(request.type) || request.payload?.challenge !== challenge) return;
      parentOrigin = event.origin;
      const ack = (ok, result, error) => send("ack", {
        requestId: request.requestId,
        ok,
        ...(ok ? { result } : { error }),
      });
      try {
        if (request.type === "testudoSetGuestCapability") {
          const credential = request.payload;
          const token = credential?.guestEmbedToken;
          const expiresAt = credential?.expiresAt;
          if (credential?.protocol !== 1 || !/^[a-f0-9]{32}$/.test(challenge) ||
              typeof token !== "string" || !/^[A-Za-z0-9._~-]{32,4096}$/.test(token) ||
              typeof credential.packageId !== "string" || credential.packageId.length < 1 || credential.packageId.length > 128 ||
              typeof credential.packageVersionId !== "string" || credential.packageVersionId.length < 1 || credential.packageVersionId.length > 128 ||
              !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 10 * 60_000) {
            throw new Error("Invalid or expired Testudo guest capability.");
          }
          guestCredential = { token, expiresAt };
          principalCredential = null;
          packageBinding = { packageId: credential.packageId, packageVersionId: credential.packageVersionId };
          chatTurns = [];
          return ack(true, { protocol: 1, challenge, expiresAt });
        }
        if (request.type === "testudoLoadPackage") {
          const { bootstrap, transport } = request.payload ?? {};
          if (typeof transport?.bearerToken !== "string" || !/^[A-Za-z0-9._~-]{16,8192}$/.test(transport.bearerToken) ||
              typeof bootstrap?.packageId !== "string" || bootstrap.packageId.length > 128 ||
              typeof bootstrap?.versionId !== "string" || bootstrap.versionId.length > 128) {
            throw new Error("Signed-in GeoAI requires package-bound Testudo viewer credentials.");
          }
          principalCredential = { bearerToken: transport.bearerToken };
          packageBinding = { packageId: bootstrap.packageId, packageVersionId: bootstrap.versionId };
          guestCredential = null;
          chatTurns = [];
          return ack(true, { configured: true, packageId: packageBinding.packageId, packageVersionId: packageBinding.packageVersionId });
        }
        if (request.type === "testudoOpenGeoAiChat") {
          if (typeof request.payload?.open !== "boolean") throw new Error("GeoAI panel open state must be boolean.");
          if (request.payload.open) {
            if (!app.openFloatingPanel?.(CHAT_PANEL_ID)) throw new Error("GeoAI panel is unavailable in this host.");
          } else app.closeFloatingPanel?.(CHAT_PANEL_ID);
          return ack(true, { open: Boolean(request.payload.open), active: request.payload.open ? true : false });
        }
        if (request.type === "testudoGetGeoAiStatus") {
          const configured = Boolean((guestCredential && guestCredential.expiresAt > Date.now()) || principalCredential);
          return ack(true, {
            configured,
            available: configured,
            providerReady: null,
            ollayaScenarioMatchingAvailable: configured,
            reason: configured ? "Testudo checks provider readiness when a message is sent." : "A Testudo signed-in or guest capability is required.",
          });
        }
        if (request.type === "testudoGetOllayaScenarioStatus") {
          const configured = Boolean((guestCredential && guestCredential.expiresAt > Date.now()) || principalCredential);
          return ack(true, {
            configured,
            available: configured,
            providerReady: null,
            reason: configured ? "Testudo's chat gateway evaluates typed scenario matching server-side for each request." : "A Testudo signed-in or guest capability is required for server-side scenario matching.",
          });
        }
        if (request.type === "testudoRequestInvestigation") {
          const question = request.payload?.question;
          if (typeof question !== "string" || !question.trim() || question.length > 4000) throw new Error("Question must contain 1 to 4000 characters.");
          if ((!guestCredential || guestCredential.expiresAt <= Date.now()) && !principalCredential) throw new Error("A Testudo signed-in or guest capability is required for GeoAI chat.");
          const requestId = request.requestId;
          ack(true, { requestId, accepted: true });
          void submitChat(question, requestId).catch(() => undefined);
          return;
        }
        if (request.type === "testudoGetState") return ack(true, state());
        if (request.type === "testudoGetCameraState") return ack(true, getCamera(app));
        if (request.type === "testudoSetCamera") {
          const camera = request.payload;
          if (!validCamera(camera)) throw new Error("Invalid camera bounds or fields.");
          const map = app.getMap?.();
          if (!map) throw new Error("Camera control is unavailable on the active renderer.");
          const options = {};
          if (camera.center !== undefined) options.center = camera.center;
          if (camera.zoom !== undefined) options.zoom = camera.zoom;
          if (camera.bearing !== undefined) options.bearing = camera.bearing;
          if (camera.pitch !== undefined) options.pitch = camera.pitch;
          map.jumpTo(options);
          return ack(true, getCamera(app));
        }
        if (request.type === "testudoGetMapControlState") return ack(true, getMapControlState(app));
        if (request.type === "testudoSetBuiltInMapControl") {
          const { control, visible } = request.payload;
          if (!CONTROL_IDS.has(control) || typeof visible !== "boolean") throw new Error("Invalid built-in map control command.");
          if (!app.setBuiltInMapControlVisible(control, visible)) throw new Error(`Map control '${control}' is unavailable.`);
          return ack(true, { control, visible: app.getBuiltInMapControlVisible?.(control) ?? visible });
        }
        if (request.type === "testudoGetPlaybackState") return ack(true, playbackState());
        if (request.type === "testudoGetProgressState") return ack(true, progressState());
        if (request.type === "testudoGetScenarioState") return ack(true, sharedSnapshot().scenario ?? { available: false, scenarios: [] });
        if (request.type === "testudoSelectScenario") {
          const { scenarioId, replicationId } = request.payload;
          if (!(typeof scenarioId === "string" && scenarioId.length > 0 && scenarioId.length <= 128 || typeof scenarioId === "number" && Number.isSafeInteger(scenarioId))) throw new Error("Scenario selection requires a valid scenario ID.");
          return ack(true, await app.sharedFeatures.selectScenario(scenarioId, replicationId));
        }
        if (PLAYBACK_COMMANDS.has(request.type)) {
          const playback = app.sharedFeatures;
          if (!playbackState().available || !playback) throw new Error("Playback is unavailable because no active plugin provides package-backed playback.");
          if (request.type === "testudoSetPlaybackPlaying") {
            if (typeof request.payload.playing !== "boolean") throw new Error("Playback playing flag must be boolean.");
            return ack(true, await playback.setPlaybackPlaying(request.payload.playing));
          }
          if (request.type === "testudoRestartPlayback") return ack(true, await playback.restartPlayback());
          if (request.type === "testudoSeekPlayback") return ack(true, await playback.seekPlayback(request.payload.tick));
          if (request.type === "testudoSetPlaybackSpeed") return ack(true, await playback.setPlaybackSpeed(request.payload.speed));
        }
      } catch (error) {
        ack(false, undefined, error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500));
      }
    };

    window.addEventListener("message", onMessage);
    unsubscribeFeatures = app.sharedFeatures?.subscribe?.((snapshot) => {
      if (snapshot.progress) send("testudoProgressChanged", snapshot.progress);
      if (snapshot.playback) send("testudoPlaybackChanged", snapshot.playback);
      if (snapshot.scenario) send("testudoScenarioChanged", snapshot.scenario);
      }) ?? null;
    if (app.registerFloatingPanel && app.openFloatingPanel) {
      unregisterChatPanel = app.registerFloatingPanel({
        id: CHAT_PANEL_ID,
        title: "Testudo GeoAI",
        defaultWidth: 380,
        defaultHeight: 480,
        render(container) {
          const doc = container.ownerDocument;
          const root = doc.createElement("div");
          root.style.cssText = "display:flex;flex-direction:column;gap:8px;height:100%;font:14px system-ui,sans-serif;color:#20252b";
          const status = doc.createElement("div"); status.setAttribute("role", "status"); status.textContent = "Ask Testudo about this package.";
          const transcript = doc.createElement("div"); transcript.setAttribute("aria-live", "polite"); transcript.style.cssText = "overflow:auto;flex:1;white-space:pre-wrap";
          const form = doc.createElement("form"); form.style.cssText = "display:flex;gap:6px";
          const input = doc.createElement("textarea"); input.setAttribute("aria-label", "Ask Testudo GeoAI"); input.maxLength = 4000; input.required = true; input.rows = 3; input.style.flex = "1";
          const submit = doc.createElement("button"); submit.type = "submit"; submit.textContent = "Send";
          form.append(input, submit); root.append(status, transcript, form); container.append(root);
          const onSubmit = async (event) => {
            event.preventDefault(); const question = input.value.trim(); if (!question) return;
            const requestId = `panel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            input.value = ""; submit.disabled = true; status.textContent = "Asking Testudo…";
            const user = doc.createElement("p"); user.textContent = `You: ${question}`; transcript.append(user);
            try { await submitChat(question, requestId); }
            catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
            finally { submit.disabled = false; }
          };
          form.addEventListener("submit", onSubmit);
          chatPanelElements = { status, transcript };
          return () => { form.removeEventListener("submit", onSubmit); chatPanelElements = null; };
        },
      });
    }
    ready();
    const readyTimer = window.setInterval(ready, 750);
    cleanupActivePlugin = () => {
      disposed = true;
      window.clearInterval(readyTimer);
      window.removeEventListener("message", onMessage);
      unsubscribeFeatures?.();
      unsubscribeFeatures = null;
      unregisterChatPanel?.();
      unregisterChatPanel = null;
      guestCredential = null;
      principalCredential = null;
      packageBinding = null;
      chatTurns = [];
      cleanupActivePlugin = null;
    };
  },
  deactivate() {
    cleanupActivePlugin?.();
  },
};

export default plugin;
