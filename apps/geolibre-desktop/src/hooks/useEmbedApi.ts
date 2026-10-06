import { useAppStore } from "@geolibre/core";
import { type RefObject, useEffect } from "react";
import { getLayerBounds, type MapEngine } from "@geolibre/map";
import { imageBlobToDataUrl } from "@geolibre/map";
import {
  TestudoFeatureBridge,
  getTestudoPackageProviderSuite,
  type TestudoArtifactRequest,
  type TestudoMapHandle,
  type TestudoPackageBootstrap,
} from "@geolibre/plugins";
import {
  buildEmbedEvent,
  buildEmbedLayer,
  createEmbedEventPoster,
  embedEventTargets,
  embedEventVersions,
  embedLayerSummaries,
  embedRequestVersion,
  isEmbedOriginAllowed,
  matchesTestudoArtifactCorrelation,
  parseEmbedRequest,
  parseTestudoArtifactResponse,
  parseTestudoEmbedRequest,
  readEmbedOrigins,
  resolveEmbedParentOrigin,
  requireEmbedLayer,
  resolveHighlightIds,
  type EmbedCommand,
  type EmbedEventType,
} from "../lib/embed-api";
import { fetchProjectFromUrl, projectUrlFromLocation } from "../lib/project-url";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import { isKnownWhiteboxToolId } from "../lib/whitebox-tool-url";
import { loadDataUrl } from "./useDataUrlLoader";
import type { createAppAPI } from "./usePlugins";
import { pickTestudoLocalDirectory, validateTestudoLocalPackage } from "../lib/testudo-local-package";

// Runtime `postMessage` API for a host page that frames GeoLibre (issue #1462).
// Where `?url=`, `?maponly`, and `?tool=` configure the app once at load time,
// this lets the host keep talking to a live map: fly to a record the user just
// clicked in the host UI, highlight it, open a processing tool, and learn when
// the user selects a feature, moves the map, or finishes a tool — all without
// reloading the iframe and throwing away the session.
//
// Trust: unlike the Jupyter bridges (which trust the page that embeds them), the
// host here is a third party, so the API stays off until the deployment names
// the origins it trusts via GEOLIBRE_EMBED_ORIGINS. Every inbound message is
// checked against that list and every outbound message is scoped to a listed
// origin, never "*" (unless the operator configured the "*" wildcard).

/** Minimum gap between `viewChanged` events while the user drags the map. */
const VIEW_THROTTLE_MS = 250;

/**
 * Bridges a framed GeoLibre with an arbitrary host page over a versioned
 * `postMessage` protocol.
 *
 * Host → app: `loadProject`, `setView`, `highlightFeature`, `openTool`.
 * App → host: `ready`, `ack`, `projectLoaded`, `selectionChanged`,
 * `viewChanged`, `toolCompleted`, `serverFileWritten`.
 *
 * The hook is an inert no-op unless the app is framed AND the deployment
 * configured an origin allowlist (see {@link readEmbedOrigins}); a public build
 * with no allowlist can never be driven by the page that frames it.
 *
 * @param mapControllerRef - Ref to the live map controller (shared with
 *   MapCanvas and the other bridges), used to drive and read the camera.
 */
export function useEmbedApi(
  mapControllerRef: RefObject<MapEngine | null>,
  mapAppAPI: ReturnType<typeof createAppAPI> | null,
  /**
   * Bumped whenever a canvas publishes an engine, so the view-listener attach
   * re-arms on a hand-off — the ref itself is stable (#2268 review).
   */
  mapReadyGeneration: number,
): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    // `ready` promises that every command is usable. Plugin-backed data loaders
    // join the API only after the map has initialized, so do not advertise the
    // bridge during the earlier render where that API is still absent.
    if (!mapAppAPI) return;
    const allowedOrigins = readEmbedOrigins();
    if (allowedOrigins.length === 0) return;
    const host = window.parent;
    // Not framed: there is no host to talk to (the app is the top-level page).
    if (!host || host === window) return;

    // A browser hint may resolve the parent before the first event; otherwise
    // the verified challenge-bearing handshake pins the origin later.
    const ancestorOrigins = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    const parentOriginHint = resolveEmbedParentOrigin([
      document.referrer,
      ancestorOrigins?.item(0),
    ], allowedOrigins);
    let hostOrigin: string | null = null;
    let hostVersion: 1 | 2 | null = null;
    let disposed = false;
    const randomChallengeBytes = new Uint8Array(16);
    crypto.getRandomValues(randomChallengeBytes);
    const testudoChallenge = [...randomChallengeBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const pendingArtifactRequests = new Map<string, {
      request: TestudoArtifactRequest;
      resolve: (bytes: ArrayBuffer) => void;
      reject: (error: Error) => void;
      timer: number;
      signal: AbortSignal;
      onAbort: () => void;
    }>();
    const fetchArtifactFromHost = (
      request: TestudoArtifactRequest,
      signal: AbortSignal,
    ): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Artifact request was cancelled.", "AbortError"));
        return;
      }
      if (!hostOrigin || !testudoChallenge || !/^[a-f0-9]{32}$/.test(testudoChallenge)) {
        reject(new Error("The embedding host is not authenticated for artifact requests."));
        return;
      }
      if (pendingArtifactRequests.has(request.requestId)) {
        reject(new Error("Artifact request id is already in flight."));
        return;
      }
      const settle = (operation: () => void) => {
        const pending = pendingArtifactRequests.get(request.requestId);
        if (!pending) return;
        pendingArtifactRequests.delete(request.requestId);
        window.clearTimeout(pending.timer);
        pending.signal.removeEventListener("abort", pending.onAbort);
        operation();
      };
      const onAbort = () => settle(() => reject(new DOMException("Artifact request was cancelled.", "AbortError")));
      const timer = window.setTimeout(
        () => settle(() => reject(new Error("The host artifact request timed out."))),
        30_000,
      );
      pendingArtifactRequests.set(request.requestId, { request, resolve, reject, timer, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        host.postMessage({
          v: 2,
          source: "geolibre",
          type: "testudoArtifactRequest",
          payload: { ...request, challenge: testudoChallenge },
        }, hostOrigin);
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    const testudo = new TestudoFeatureBridge((bootstrap) => getTestudoPackageProviderSuite(bootstrap), fetchArtifactFromHost);
    testudo.setMapResolver(() => (mapControllerRef.current?.getMap() ?? null) as TestudoMapHandle | null);
    const postEmbedEvent = createEmbedEventPoster(
      (message, targetOrigin) => host.postMessage(message, targetOrigin),
      (error) => console.error("[GeoLibre] Failed to post embed event", error),
    );
    const postEvent = (hostOriginForEvent: string | null, message: unknown) => {
      const [targetOrigin] = embedEventTargets(hostOriginForEvent, allowedOrigins);
      if (!targetOrigin) return;
      postEmbedEvent(message, targetOrigin);
    };

    const emit = (type: EmbedEventType, payload: Record<string, unknown>, version?: 1 | 2) => {
      if (disposed) return;
      const targetOrigin = hostOrigin ?? parentOriginHint;
      if (!embedEventTargets(targetOrigin, allowedOrigins).length) return;
      const versions = embedEventVersions(version, hostVersion);
      for (const eventVersion of versions) {
        const message = buildEmbedEvent(type, payload, eventVersion);
        postEvent(targetOrigin, message);
      }
    };

    let openingLocalPackage = false;

    const ack = (
      requestId: string | null,
      version: 1 | 2,
      ok: boolean,
      error?: string,
      result?: unknown,
    ) => {
      if (!requestId) return;
      emit(
        "ack",
        {
          requestId,
          ok,
          ...(error ? { error } : {}),
          ...(result === undefined ? {} : { result }),
        },
        version,
      );
    };

    const emitTestudoState = (tviewId: string) => {
      try {
        emit("testudoStateChanged", testudo.getState(tviewId) as unknown as Record<string, unknown>, 2);
      } catch {
        // A closed TView has no state to publish.
      }
    };
    const unsubscribeActiveTView = testudo.subscribeActiveTView((tviewId) => {
      emit("testudoActiveTViewChanged", { tviewId }, 2);
    });
    const unsubscribeGeoAI = testudo.subscribeGeoAIRequests((request) => {
      emit("testudoGeoAIRequest", request as unknown as Record<string, unknown>, 2);
    });
    const unsubscribePlayback = testudo.subscribePlayback((tviewId, state) => {
      emit("testudoPlaybackChanged", { ...state, tviewId }, 2);
    });
    const requiredText = (payload: Record<string, unknown>, name: string, max = 512) => {
      const value = payload[name];
      if (typeof value !== "string" || !value.trim() || value.length > max) {
        throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
      }
      return value;
    };
    const scopedId = (payload: Record<string, unknown>) => requiredText(payload, "tviewId", 120);
    const playbackGeneration = (payload: Record<string, unknown>) => {
      if (payload.generation === undefined) return undefined;
      if (!Number.isSafeInteger(payload.generation) || (payload.generation as number) < 1) {
        throw new Error("generation must be a positive safe integer.");
      }
      return payload.generation as number;
    };
    const testudoState = (tviewId: string) => emitTestudoState(tviewId);
    const openLocalPackage = async (tviewId: string) => {
      // Check scope before opening a privileged picker, and invoke it before the
      // first await so the browser can use the parent click's transient activation.
      testudo.getState(tviewId);
      if (openingLocalPackage) throw new Error("A local package is already being opened.");
      openingLocalPackage = true;
      try {
        const directory = await pickTestudoLocalDirectory();
        const local = await validateTestudoLocalPackage(directory);
        const selectedPlugin = local.capabilities.find((item) => item.available)?.id;
        if (!selectedPlugin) throw new Error("This package has no supported Testudo viewer capability.");
        const bootstrap: TestudoPackageBootstrap = {
          packageId: local.packageId,
          versionId: "local",
          label: local.label,
          artifactEndpoint: "",
          origin: "local",
          capabilities: local.capabilities,
          selectedPlugin,
        };
        await testudo.loadPackage(tviewId, bootstrap, (progress) => {
          emit("testudoStateChanged", {
            ...testudo.getState(tviewId),
            progress: { label: progress.label ?? "Loading local package", value: progress.value, loaded: progress.loaded, total: progress.total },
          }, 2);
        }, local.readArtifact);
        testudoState(tviewId);
        return testudo.getState(tviewId);
      } finally {
        openingLocalPackage = false;
      }
    };
    const runTestudoCommand = async (type: string, payload: Record<string, unknown>): Promise<unknown> => {
      switch (type) {
        case "testudoCreateTView": {
          const result = testudo.createTView(requiredText(payload, "tviewId", 120));
          emitTestudoState(result.tviewId);
          return result;
        }
        case "testudoGetTViews": return testudo.getTViews();
        case "testudoSetActiveTView": {
          const result = testudo.setActiveTView(scopedId(payload));
          emit("testudoActiveTViewChanged", result, 2);
          return result;
        }
        case "testudoGetActiveTView": return testudo.getActiveTView();
        case "testudoOpenLocalPackage": return openLocalPackage(scopedId(payload));
        case "testudoLoadPackage": {
          const tviewId = scopedId(payload);
          const bootstrap = payload.bootstrap as TestudoPackageBootstrap | undefined;
          if (!bootstrap || typeof bootstrap !== "object") throw new Error("A published package bootstrap is required.");
          const selectedPlugin = typeof payload.selectedPlugin === "string"
            ? payload.selectedPlugin
            : bootstrap.capabilities?.find((item) => item.available)?.id;
          const result = await testudo.loadPackage(tviewId, { ...bootstrap, ...(selectedPlugin ? { selectedPlugin } : {}) }, (progress) => {
            emit("testudoStateChanged", {
              ...testudo.getState(tviewId),
              progress: { label: progress.label ?? "Loading package", value: progress.value, loaded: progress.loaded, total: progress.total },
            }, 2);
          });
          testudoState(tviewId);
          return testudo.getState(tviewId);
        }
        case "testudoGetState": return testudo.getState(scopedId(payload));
        case "testudoSetPlugin": await testudo.selectPlugin(scopedId(payload), requiredText(payload, "id", 80)); testudoState(scopedId(payload)); return testudo.getState(scopedId(payload));
        case "testudoSetPreset": await testudo.applyPreset(scopedId(payload), requiredText(payload, "id", 100)); testudoState(scopedId(payload)); return testudo.getState(scopedId(payload));
        case "testudoSetMode":
        case "testudoSetViewMode": {
          const tviewId = scopedId(payload);
          const selected = await testudo.setViewMode(tviewId, requiredText(payload, "mode", 20) as "animation" | "flow" | "paths" | "density");
          testudoState(tviewId);
          return { mode: selected };
        }
        case "testudoSetScenario": {
          const tviewId = scopedId(payload);
          const id = await testudo.selectScenario(tviewId, requiredText(payload, "scenarioId", 120));
          const scenario = testudo.sessions.get(tviewId)?.scenarios?.find((item) => item.id === id);
          testudoState(tviewId);
          return { id, label: scenario?.label ?? id, selected: true, replicationIds: scenario?.replications?.map((item) => item.id) ?? [] };
        }
        case "testudoSetPlaybackPlaying": {
          const tviewId = scopedId(payload);
          if (typeof payload.playing !== "boolean") throw new Error("playing must be a boolean.");
          const state = await testudo.playback(tviewId, payload.playing ? "play" : "pause", undefined, playbackGeneration(payload));
          emit("testudoPlaybackChanged", { ...state, tviewId }, 2);
          return state;
        }
        case "testudoRestartPlayback": {
          const tviewId = scopedId(payload); const state = await testudo.playback(tviewId, "restart", undefined, playbackGeneration(payload));
          emit("testudoPlaybackChanged", { ...state, tviewId }, 2); return state;
        }
        case "testudoSeekPlayback":
        case "testudoSetPlaybackSpeed": {
          const tviewId = scopedId(payload); const isSeek = type === "testudoSeekPlayback";
          const value = payload[isSeek ? "tick" : "speed"];
          if (typeof value !== "number") throw new Error(`${isSeek ? "tick" : "speed"} must be a number.`);
          const state = await testudo.playback(tviewId, isSeek ? "seek" : "speed", value, playbackGeneration(payload));
          emit("testudoPlaybackChanged", { ...state, tviewId }, 2); return state;
        }
        case "testudoGetPlaybackState": return testudo.getPlaybackState(scopedId(payload), playbackGeneration(payload));
        case "testudoSetCameraView": {
          const tviewId = scopedId(payload); const view = payload.view as { center: [number, number]; zoom: number; bearing?: number; pitch?: number };
          if (!view || !Array.isArray(view.center)) throw new Error("view must contain a camera center and zoom.");
          await testudo.setCameraView(tviewId, view); return view;
        }
        case "testudoGetCameraView": return testudo.getCameraView(scopedId(payload));
        case "testudoSetMapControl": {
          const tviewId = scopedId(payload); if (typeof payload.visible !== "boolean") throw new Error("visible must be a boolean.");
          return { visible: await testudo.setMapControl(tviewId, requiredText(payload, "controlId", 100), payload.visible) };
        }
        case "testudoSetNetworkFilter": {
          const tviewId = scopedId(payload); const filter = payload.filter as { id?: unknown; enabled?: unknown; value?: unknown };
          if (!filter || typeof filter.id !== "string" || typeof filter.enabled !== "boolean") throw new Error("filter must contain id and enabled.");
          await testudo.setNetworkFilter(tviewId, filter as { id: string; enabled: boolean; value?: string | number | boolean }); return { applied: true };
        }
        case "testudoSetLegendVisibility":
        case "testudoSetEsriWorldImagery": {
          const tviewId = scopedId(payload); if (typeof payload.visible !== "boolean") throw new Error("visible must be a boolean.");
          const controlId = type === "testudoSetLegendVisibility" ? "legend" : "esri-world-imagery";
          return { visible: await testudo.setMapControl(tviewId, controlId, payload.visible) };
        }
        case "testudoSetKpiGeometry": {
          const tviewId = scopedId(payload); if (typeof payload.visible !== "boolean" || (payload.geometry !== "lanes" && payload.geometry !== "sections")) throw new Error("geometry and visible are invalid.");
          return testudo.setKpiGeometry(tviewId, payload.geometry, payload.visible);
        }
        case "testudoGetKpiGeometryState": return testudo.getKpiGeometryState(scopedId(payload));
        case "testudoSetRenderer": {
          const tviewId = scopedId(payload); if (payload.renderer !== "maplibre" && payload.renderer !== "cesium") throw new Error("renderer is invalid.");
          return { renderer: await testudo.setRenderer(tviewId, payload.renderer) };
        }
        case "testudoGetMapControlState": return testudo.getMapControlState(scopedId(payload));
        case "testudoRequestInvestigation": {
          const result = await testudo.requestInvestigation(scopedId(payload), requiredText(payload, "question", 8_000), typeof payload.activeScenarioId === "string" ? payload.activeScenarioId : undefined);
          return result;
        }
        case "testudoRespondGeoAIRequest": {
          const requestId = requiredText(payload, "requestId", 200);
          const tviewId = scopedId(payload);
          if (typeof payload.generation !== "number" || !Number.isSafeInteger(payload.generation) || payload.generation < 1) {
            throw new Error("GeoAI reply generation is invalid.");
          }
          const reply = {
            ...(typeof payload.content === "string" ? { content: payload.content } : {}),
            ...(typeof payload.error === "string" ? { error: payload.error } : {}),
          };
          return testudo.respondGeoAIRequestTuple(requestId, tviewId, payload.generation, reply);
        }
        case "testudoOpenAnnotations": return { active: await testudo.openAnnotations(scopedId(payload)) };
        case "testudoOpenRecordTour": await testudo.openRecordTour(scopedId(payload)); return { opened: true };
        case "testudoOpenRecordVideo": await testudo.openRecordVideo(scopedId(payload)); return { opened: true };
        default: throw new Error(`Unsupported Testudo command: ${type}`);
      }
    };

    const controller = () => mapControllerRef.current;

    // -- verbs ---------------------------------------------------------------

    // The URL the current project came from, echoed in `projectLoaded` so the
    // host can tell its own load from one the user triggered.
    let projectSourceUrl: string | null = projectUrlFromLocation();
    let loadAbort: AbortController | null = null;
    const dataLoadAborts = new Set<AbortController>();
    let dataLoadQueue: Promise<void> = Promise.resolve();

    const queueDataLoad = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = dataLoadQueue.then(operation, operation);
      dataLoadQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const loadProjectFromUrl = async (url: string) => {
      // A second load supersedes the first; otherwise a slow fetch could land
      // after a newer one and leave the map showing the wrong project.
      loadAbort?.abort();
      const abort = new AbortController();
      loadAbort = abort;
      const project = await fetchProjectFromUrl(url, { signal: abort.signal });
      const resolved = await resolveProjectXyzLayers(project, abort.signal);
      if (abort.signal.aborted) return;
      projectSourceUrl = url;
      // Host-driven loads are transient deep links, like `?url=`: they are not
      // added to the recent-projects list.
      useAppStore.getState().loadProject(resolved, null, { rememberRecent: false });
    };

    const applySetView = (command: Extract<EmbedCommand, { type: "setView" }>) => {
      const map = controller();
      if (!map) throw new Error("The map is not ready yet");
      if (command.target.kind === "bbox") map.fitBounds(command.target.bbox);
      else {
        const { kind: _kind, ...camera } = command.target;
        map.flyTo(camera);
      }
    };

    const applyHighlight = (command: Extract<EmbedCommand, { type: "highlightFeature" }>) => {
      const { target } = command;
      const state = useAppStore.getState();
      const layer = state.layers.find((item) => item.id === target.layerId);
      if (!layer) throw new Error(`No layer with id "${target.layerId}"`);
      const ids = resolveHighlightIds(layer.geojson?.features ?? [], target);
      // A request that names nothing is the documented "clear the highlight"
      // form. A request that DOES name features but resolves to none is a
      // failure, not a clear: the id may be a typo, or the layer may keep its
      // features in its MapLibre source rather than `geojson` (vector tiles,
      // source-owned layers), where nothing can be resolved here. Report that
      // instead of wiping the user's selection behind an `ok` ack.
      const askedForFeatures = target.featureIds.length > 0 || target.filter !== null;
      if (askedForFeatures && ids.length === 0) {
        throw new Error(
          `highlightFeature matched no features in layer "${target.layerId}"` +
            (layer.geojson ? "" : " (the layer's features are not readable from the store)"),
        );
      }
      // Drive the store as well as the map so the Attribute table and Layers
      // panel agree with what the host highlighted, exactly as a map click does.
      state.selectLayer(target.layerId);
      state.selectFeatures(ids);
      controller()?.highlightFeature(layer, ids, { fit: target.fit });
      return ids;
    };

    const applyOpenTool = (command: Extract<EmbedCommand, { type: "openTool" }>) => {
      const state = useAppStore.getState();
      if (!isKnownWhiteboxToolId(command.id)) {
        // Mirror `?tool=<unknown>`: open Processing without a preselection
        // rather than silently doing nothing.
        state.setProcessingInitialTool(null);
        state.setProcessingOpen(true);
        throw new Error(`Unknown tool "${command.id}"`);
      }
      if (Object.keys(command.params).length > 0) {
        state.setProcessingRerun({
          kind: "whitebox",
          toolId: command.id,
          parameters: command.params,
        });
      }
      state.setProcessingInitialTool(command.id);
      state.setProcessingOpen(true);
    };

    const requireLayer = (layerId: string) =>
      requireEmbedLayer(useAppStore.getState().layers, layerId);

    const runCommand = async (command: EmbedCommand): Promise<unknown> => {
      switch (command.type) {
        case "loadProject":
          if (!useAppStore.getState().deploymentCapabilities.has("project:edit"))
            throw new Error("Missing project:edit capability");
          await loadProjectFromUrl(command.url);
          return;
        case "getRenderer":
          return useAppStore.getState().primaryRenderer;
        case "setRenderer":
          useAppStore.getState().setPrimaryRenderer(command.renderer);
          return;
        case "setView":
          applySetView(command);
          return;
        case "highlightFeature":
          applyHighlight(command);
          return;
        case "openTool":
          if (!useAppStore.getState().deploymentCapabilities.has("processing:run"))
            throw new Error("Missing processing:run capability");
          applyOpenTool(command);
          return;
        case "setLayerVisibility":
          requireLayer(command.layerId);
          useAppStore.getState().setLayerVisibility(command.layerId, command.visible);
          return;
        case "listLayers":
          return embedLayerSummaries(useAppStore.getState().layers);
        case "setFilter":
          requireLayer(command.layerId);
          useAppStore.getState().updateLayer(command.layerId, {
            embedFilter: command.expression ?? undefined,
          });
          return;
        case "getViewport": {
          const view = controller()?.readView();
          if (!view) throw new Error("The map is not ready yet");
          return view;
        }
        case "addLayer": {
          const state = useAppStore.getState();
          if (!state.deploymentCapabilities.has("data:add"))
            throw new Error("Missing data:add capability");
          const layer = buildEmbedLayer(command.spec, state.layers);
          state.addLayer(layer, command.spec.beforeId);
          return layer.id;
        }
        case "addData": {
          if (!useAppStore.getState().deploymentCapabilities.has("data:add"))
            throw new Error("Missing data:add capability");
          const abort = new AbortController();
          dataLoadAborts.add(abort);
          const result = await queueDataLoad(() =>
            loadDataUrl(mapAppAPI, command.url, {
              styleUrl: command.styleUrl,
              signal: abort.signal,
              fit: command.fit,
            }),
          ).finally(() => dataLoadAborts.delete(abort));
          if (command.fit) {
            const bounds = useAppStore
              .getState()
              .layers.filter((layer) => result.fitLayerIds.includes(layer.id))
              .map(getLayerBounds)
              .filter((value) => value !== null);
            if (bounds.length) {
              controller()?.fitBounds([
                Math.min(...bounds.map((value) => value[0])),
                Math.min(...bounds.map((value) => value[1])),
                Math.max(...bounds.map((value) => value[2])),
                Math.max(...bounds.map((value) => value[3])),
              ]);
            }
          }
          return result.layerIds;
        }
        case "exportImage": {
          if (!useAppStore.getState().deploymentCapabilities.has("export:data"))
            throw new Error("Missing export:data capability");
          const engine = controller();
          if (!engine) throw new Error("The map is not ready yet");
          return imageBlobToDataUrl(await engine.captureImage());
        }
      }
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== host) return;
      if (!isEmbedOriginAllowed(event.origin, allowedOrigins)) return;
      if (hostOrigin && event.origin !== hostOrigin) return;
      if (
        event.data && typeof event.data === "object" &&
        (event.data as Record<string, unknown>).source === "testudo"
      ) {
        if ((event.data as Record<string, unknown>).type === "testudoArtifactResponse") {
          if (!hostOrigin || event.origin !== hostOrigin) return;
          const response = parseTestudoArtifactResponse(event.data, testudoChallenge);
          if (!response) return;
          const pending = pendingArtifactRequests.get(response.requestId);
          if (!pending || !matchesTestudoArtifactCorrelation(pending.request, response)) return;
          try {
            if (testudo.getState(response.tviewId).generation !== response.generation) return;
          } catch {
            return;
          }
          pendingArtifactRequests.delete(response.requestId);
          window.clearTimeout(pending.timer);
          pending.signal.removeEventListener("abort", pending.onAbort);
          if (response.bytes) pending.resolve(response.bytes);
          else pending.reject(new Error(response.error ?? "The host could not fetch the requested artifact."));
          return;
        }
        const request = parseTestudoEmbedRequest(event.data, testudoChallenge);
        if (!request) return;
        if (!hostOrigin && event.origin && event.origin !== "null") hostOrigin = event.origin;
        hostVersion ??= 2;
        void runTestudoCommand(request.type, request.payload).then(
          (result) => ack(request.requestId, 2, true, undefined, result),
          (error: unknown) => ack(
            request.requestId,
            2,
            false,
            error instanceof Error ? error.message : String(error),
          ),
        );
        return;
      }
      const request = parseEmbedRequest(event.data);
      if (!request) return;
      // A valid, allowed message identifies the host: scope every later event to
      // exactly this origin. ("null" is an opaque origin, only reachable under
      // the wildcard, and cannot be used as a postMessage target.)
      if (!hostOrigin && event.origin && event.origin !== "null") hostOrigin = event.origin;
      const requestVersion = embedRequestVersion(event.data);
      hostVersion ??= requestVersion;
      if ("error" in request) {
        ack(request.requestId, requestVersion, false, request.error);
        return;
      }
      void runCommand(request.command).then(
        (result) => ack(request.requestId, requestVersion, true, undefined, result),
        (error: unknown) => {
          ack(
            request.requestId,
            requestVersion,
            false,
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    };

    window.addEventListener("message", handleMessage);

    // -- events --------------------------------------------------------------

    const store = useAppStore.getState();
    let prevRenderer = store.primaryRenderer;
    let prevGeneration = store.projectGeneration;
    let prevSelectedLayer = store.selectedLayerId;
    let prevSelection = store.selectedFeatureIds.join(" ");
    const emittedRuns = new Set(store.processingHistory.map((run) => run.id));

    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.primaryRenderer !== prevRenderer) {
        prevRenderer = state.primaryRenderer;
        emit("rendererchange", { renderer: prevRenderer });
      }
      if (state.projectGeneration !== prevGeneration) {
        prevGeneration = state.projectGeneration;
        emit("projectLoaded", {
          url: projectSourceUrl,
          name: state.projectName,
          layerIds: state.layers.map((layer) => layer.id),
        });
      }
      const selection = state.selectedFeatureIds.join(" ");
      if (selection !== prevSelection || state.selectedLayerId !== prevSelectedLayer) {
        prevSelection = selection;
        prevSelectedLayer = state.selectedLayerId;
        emit("selectionChanged", {
          layerId: state.selectedLayerId,
          featureIds: [...state.selectedFeatureIds],
        });
      }
      for (const run of state.processingHistory) {
        if (emittedRuns.has(run.id)) continue;
        emittedRuns.add(run.id);
        emit("toolCompleted", {
          id: run.toolId,
          name: run.toolName,
          status: run.status,
          engine: run.engine,
          durationMs: run.durationMs,
          outputLayerNames: run.outputLayerNames ?? [],
          ...(run.error ? { error: run.error } : {}),
        });
        // File-based tools (the sidecar's conversion/Whitebox jobs) record where
        // they wrote; surface that as its own event so a host can pick the file
        // up server-side.
        if (run.status === "success" && run.outputPath) {
          emit("serverFileWritten", { path: run.outputPath, toolId: run.toolId });
        }
      }
    });

    // Camera events. The engine appears asynchronously after its canvas mounts,
    // so poll only until the renderer-neutral event surface is published.
    let unsubscribeMove: (() => void) | null = null;
    let unsubscribeIdle: (() => void) | null = null;
    let lastViewAt = 0;
    let trailingTimer: number | null = null;
    const postView = () => {
      const view = controller()?.readView();
      if (!view) return;
      lastViewAt = Date.now();
      emit("viewChanged", {
        bbox: view.bbox ?? null,
        center: view.center,
        zoom: view.zoom,
        bearing: view.bearing,
        pitch: view.pitch,
      });
    };
    const onMapMove = () => {
      const elapsed = Date.now() - lastViewAt;
      if (elapsed >= VIEW_THROTTLE_MS) {
        if (trailingTimer !== null) {
          window.clearTimeout(trailingTimer);
          trailingTimer = null;
        }
        postView();
        return;
      }
      // Within the throttle window: schedule the trailing edge so the host still
      // gets the final position of a drag.
      if (trailingTimer !== null) return;
      trailingTimer = window.setTimeout(() => {
        trailingTimer = null;
        postView();
      }, VIEW_THROTTLE_MS - elapsed);
    };
    let rafId: number | null = null;
    const attach = () => {
      const engine = controller();
      if (!engine) {
        rafId = requestAnimationFrame(attach);
        return;
      }
      unsubscribeMove = engine.onCameraMove(onMapMove);
      unsubscribeIdle = engine.onCameraIdle(onMapMove);
    };
    rafId = requestAnimationFrame(attach);

    // A renderer hand-off bumps the generation before the destination engine
    // has published, so this effect re-runs while the ref is still empty (or
    // aimed at the outgoing engine). `ready` promises every command is usable:
    // hold it until the engine for the current renderer is live, and the
    // publish bump re-runs this effect to emit it then.
    const engine = controller();
    if (engine && engine.kind === useAppStore.getState().primaryRenderer) {
      emit("ready", { version: __GEOLIBRE_VERSION__, challenge: testudoChallenge });
    }

    return () => {
      disposed = true;
      for (const pending of pendingArtifactRequests.values()) {
        window.clearTimeout(pending.timer);
        pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(new Error("The Testudo embed session ended."));
      }
      pendingArtifactRequests.clear();
      window.removeEventListener("message", handleMessage);
      unsubscribe();
      unsubscribeActiveTView();
      unsubscribeGeoAI();
      unsubscribePlayback();
      loadAbort?.abort();
      for (const abort of dataLoadAborts) abort.abort();
      dataLoadAborts.clear();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      unsubscribeMove?.();
      unsubscribeIdle?.();
    };
  }, [mapControllerRef, mapAppAPI, mapReadyGeneration]);
}
