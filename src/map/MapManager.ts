/// <reference types="geojson" />
// src/map/MapManager.ts
//
// MapManager owns the imperative Mapbox GL JS `Map` instance lifecycle behind a
// small typed API (design → "Map rendering architecture → Mapbox instance
// lifecycle"). React (MapView, Task 11) never touches the raw map object; it
// mounts a container and delegates to this class.
//
// Group 2 engine swap: the underlying renderer is now `mapbox-gl` (direct, not
// react-map-gl), constructed with a STOCK MAPBOX STYLE URL and the Mapbox access
// token applied at construction. The imperative MapManager abstraction and the
// engine-agnostic MinimalMap interface are preserved unchanged — mapbox-gl's
// `Map` satisfies the same on/off/remove/resize/fitBounds/getZoom/setZoom/
// flyTo/easeTo/setPitch/setBearing/getContainer surface.
//
// Non-rendering logic (extent framing, the 15s tile watchdog, resize handling,
// zoom clamping, and destroy/cleanup) is written so it is unit-testable WITHOUT
// a real WebGL map: the mapboxgl.Map constructor is dependency-injected via
// `mapFactory`, so tests can pass a fake Map with mocked methods (see
// MapManager.test.ts).

import mapboxgl from 'mapbox-gl';
import type { AppConfig } from '../types/config';
import {
  BAHAROUTE_STANDARD_CONFIG,
  bahaRouteStyleUrl,
  STANDARD_BASEMAP_IMPORT_ID,
  STYLE_MAX_ZOOM,
  STYLE_MIN_ZOOM,
} from './basemap/BahaRouteStyle';
import {
  METRO_MANILA_EXTENT,
  METRO_MANILA_MAX_BOUNDS,
  METRO_MANILA_NEARBY_MAX_BOUNDS,
} from './metroManilaExtent';
import { metroManilaCityBoundaries } from '../data/geojson/metroManilaCityBoundaries';
import {
  buildMetroManilaClipMask,
  NCR_CLIP_LAYER_ID,
  NCR_CLIP_SOURCE_ID,
} from './metroManilaClipMask';
import {
  installNcrOutsideMask,
  NCR_OUTSIDE_MASK_LAYER_ID,
  type MaskMapAdapter,
} from './ncrOutsideMask';
import { distanceMeters, outsideRadiusMask } from '../simulation/routeGeometry';
import {
  OVERVIEW_BOUNDS,
  OVERVIEW_DESKTOP_CENTER,
  overviewFitOptions,
  computeOverviewFraming,
} from '../camera/overviewFraming';

/** How long to wait for the base map to load before declaring failure (Req 1.6). */
export const TILE_WATCHDOG_MS = 15_000;

/**
 * Initial constructor center `[lng, lat]` for the map's first paint. Uses the
 * tuned Metro Manila overview center (inside the NCR extent) so startup is
 * already NCR-focused before {@link MapManager.frameOverview} refines the
 * framing on load (Req 1.2).
 */
const INITIAL_CENTER: [number, number] = OVERVIEW_DESKTOP_CENTER;

/**
 * Initial constructor zoom for the first paint. ~11 frames the NCR at a
 * recognizable scale; sits inside the style bounds `[STYLE_MIN_ZOOM,
 * STYLE_MAX_ZOOM]`. frameOverview() applies the responsive framing on load.
 */
const INITIAL_ZOOM = 11.4;

/** Camera pitch (degrees) used while the 3D view is on. */
export const VIEW_3D_PITCH = 60;

// --- Origin preview (trip planning) ----------------------------------------
/** Street/neighborhood zoom for the 3D origin preview (keeps road context). */
export const ORIGIN_PREVIEW_ZOOM = 16;
/** Moderate 3D pitch for the origin preview (45–60°, not the steep drive cam). */
export const ORIGIN_PREVIEW_PITCH = 55;
/** Origin-preview fly duration (ms). */
export const ORIGIN_PREVIEW_DURATION_MS = 1200;
/** Padding (px) when framing the origin + destination together. */
export const PLAN_FRAME_PADDING = 96;
/** Pitch used when framing both trip points (mild 3D, keeps overview legible). */
export const PLAN_FRAME_PITCH = 30;

/**
 * The Map Context presentation mode:
 *  - `ncr-only` (default): strict NCR-only — outside masked, external labels
 *    suppressed, camera tightly constrained.
 *  - `nearby`: surrounding provinces shown for orientation only (thematic data
 *    stays NCR-only regardless).
 */
export type MapContext = 'ncr-only' | 'nearby';

/** Duration (ms) of the 2D ↔ 3D camera tilt animation. */
const VIEW_MODE_TRANSITION_MS = 800;

// --- Drive view (demo simulation) -------------------------------------------
/** Follow-camera zoom / pitch while driving. */
export const DRIVE_ZOOM = 16.5;
export const DRIVE_PITCH = 50;

/**
 * Camera presets for the drive: `follow` is the overview-ish chase camera;
 * `driver` is a Google/Apple-style navigation camera (close, steep, with the
 * car pushed into the lower third via top padding).
 */
export type DriveCameraMode = 'follow' | 'driver';
export const DRIVE_CAMERAS: Record<
  DriveCameraMode,
  { zoom: number; pitch: number; topPaddingRatio: number }
> = {
  follow: { zoom: DRIVE_ZOOM, pitch: DRIVE_PITCH, topPaddingRatio: 0 },
  driver: { zoom: 20, pitch: 68, topPaddingRatio: 0.45 },
};

/** Selectable 3D radius presets (meters) around the vehicle. */
export const DRIVE_RADIUS_OPTIONS = [250, 600] as const;
export type DriveRadius = (typeof DRIVE_RADIUS_OPTIONS)[number];
/** Default 3D radius (follow camera). */
export const DRIVE_3D_RADIUS_M: DriveRadius = 600;

/** A point overlay drawn during the drive (e.g. a demo hazard). */
export interface DriveMarker {
  position: [number, number];
  color: string;
  label?: string;
}

/** One candidate route for the pre-drive preview (id + ordered [lng,lat]). */
export interface PreviewRoute {
  id: string;
  geometry: ReadonlyArray<[number, number]>;
  markers?: ReadonlyArray<DriveMarker>;
}
/** Move the radius clip only after the vehicle travels this far. */
export const DRIVE_RADIUS_UPDATE_M = 150;
/** Per-frame bearing smoothing factor (0..1). */
const DRIVE_BEARING_SMOOTHING = 0.15;
/** App accent blue (matches --baharoute-focus-ring-color); not a flood color. */
const DRIVE_COLOR = '#1a56db';

const DRIVE_ROUTE_SOURCE = 'drive-route';
const DRIVE_ROUTE_LAYER = 'drive-route-line';

// --- Route preview (pre-drive planning) ------------------------------------
/** Source/layers for the route-preview lines + origin/destination markers. */
const PREVIEW_ALT_SOURCE = 'route-preview-alt';
const PREVIEW_ALT_LAYER = 'route-preview-alt-line';
const PREVIEW_SEL_SOURCE = 'route-preview-selected';
const PREVIEW_SEL_LAYER = 'route-preview-selected-line';
const PREVIEW_SEL_CASING = 'route-preview-selected-casing';
const PREVIEW_ENDS_SOURCE = 'route-preview-ends';
const PREVIEW_ENDS_LAYER = 'route-preview-ends-dot';
const PREVIEW_FLOODS_SOURCE = 'route-preview-floods';
const PREVIEW_FLOODS_LAYER = 'route-preview-floods-dot';
const PREVIEW_FLOODS_LABEL = 'route-preview-floods-label';
/** Accent for the selected/recommended preview route (matches drive accent). */
const PREVIEW_SELECTED_COLOR = '#1a56db';
/** Muted color for alternative preview routes. */
const PREVIEW_ALT_COLOR = '#9aa4b2';
const DRIVE_CAR_SOURCE = 'drive-car';
const DRIVE_CAR_LAYER = 'drive-car-dot';
const DRIVE_RADIUS_SOURCE = 'drive-3d-radius-mask';
const DRIVE_RADIUS_LAYER = 'drive-3d-radius-clip';
const DRIVE_MARKERS_SOURCE = 'drive-markers';
const DRIVE_MARKERS_LAYER = 'drive-markers-dot';
const DRIVE_MARKERS_LABEL = 'drive-markers-label';

/** One simulated vehicle update. */
export interface DriveUpdate {
  position: [number, number];
  bearing: number;
}

function pointFeature(position: [number, number]): GeoJSON.Feature<GeoJSON.Point> {
  return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: position } };
}

/**
 * The minimal, ENGINE-AGNOSTIC subset of the map `Map` API that MapManager
 * uses. Kept intentionally small and structurally typed so tests can supply a
 * fake Map (with mocked functions) via {@link MapManagerInitOptions.mapFactory}
 * without instantiating a real WebGL map. The real `mapboxgl.Map` satisfies
 * this shape (as did the previous MapLibre map), so swapping the engine did not
 * require changing this interface.
 */
export interface MinimalMap {
  on(type: string, listener: (...args: unknown[]) => void): unknown;
  off(type: string, listener: (...args: unknown[]) => void): unknown;
  once?(type: string, listener: (...args: unknown[]) => void): unknown;
  remove(): void;
  resize(): unknown;
  fitBounds(bounds: unknown, options?: unknown): unknown;
  getZoom(): number;
  setZoom(zoom: number): unknown;
  getMinZoom?(): number;
  getMaxZoom?(): number;
  // Optional camera controls (Milestone A, Req 1.2, 10.5). Declared OPTIONAL so
  // existing fakes/minimal maps remain structurally valid without providing
  // them; MapManager guards each call so an absent method is a safe no-op.
  flyTo?(options: unknown): unknown;
  easeTo?(options: unknown): unknown;
  setPitch?(pitch: number): unknown;
  setBearing?(bearing: number): unknown;
  getBearing?(): number;
  /**
   * Optional container accessor (the real Mapbox `Map` exposes `getContainer()`).
   * Used by {@link MapManager.frameOverview} to measure the viewport for the
   * aspect-ratio-aware framing. Declared OPTIONAL so minimal fakes stay valid;
   * when absent, MapManager falls back to the MapManager-held container ref, and
   * failing that to the plain fitBounds framing.
   */
  getContainer?(): HTMLElement;
  // Optional style APIs for the Standard 3D view. OPTIONAL so minimal fakes
  // stay valid; MapManager guards each call.
  setConfigProperty?(importId: string, name: string, value: unknown): unknown;
  addSource?(id: string, source: unknown): unknown;
  addLayer?(layer: unknown, beforeId?: string): unknown;
  getLayer?(id: string): unknown;
  /** Optional custom-image registry APIs (community-report SVG markers). */
  addImage?(id: string, image: unknown, options?: unknown): unknown;
  hasImage?(id: string): boolean;
  /** Optional layout-property setter (used to toggle the outside-NCR mask). */
  setLayoutProperty?(layerId: string, name: string, value: unknown): unknown;
  /** Optional camera pan constraint setter (used by the Map Context switch). */
  setMaxBounds?(bounds: unknown): unknown;
  // Optional APIs for the drive simulation (camera follow + live sources).
  jumpTo?(options: unknown): unknown;
  getSource?(id: string): { setData?(data: unknown): unknown } | undefined;
  removeLayer?(id: string): unknown;
  removeSource?(id: string): unknown;
  isStyleLoaded?(): boolean;
}

/**
 * Options accepted by the mapbox-gl `Map` constructor that MapManager sets.
 *
 * Group 2 shape change: `style` is now a stock Mapbox style URL string (was a
 * hand-authored style spec object), the map is framed via `center`/`zoom`
 * (a sensible Metro Manila starting view) rather than constructor `bounds`, and
 * the Mapbox `accessToken` is passed here so the map can resolve the
 * `mapbox://` style + tiles. The token flows from {@link AppConfig.tileKey}
 * (env) — never hardcoded (Req 17.1, 17.2).
 */
export interface MapConstructorOptions {
  container: HTMLElement | string;
  /** A stock Mapbox style URL, e.g. `mapbox://styles/mapbox/standard`. */
  style: string;
  /** Initial center `[lng, lat]` — a Metro Manila / NCR-focused first paint. */
  center: [number, number];
  /** Initial zoom for the first paint (frameOverview refines it on load). */
  zoom: number;
  minZoom: number;
  maxZoom: number;
  /**
   * Camera pan constraint `[[west, south], [east, north]]` — the NCR-only
   * presentation restricts panning to a padded box around Metro Manila.
   */
  maxBounds?: [[number, number], [number, number]];
  /** Enable right-drag / keyboard bearing rotation (full 360°). */
  dragRotate?: boolean;
  /** Rotate the camera pitch together with bearing while rotating. */
  pitchWithRotate?: boolean;
  /** Enable two-finger touch rotate (and pinch-zoom rotate). */
  touchZoomRotate?: boolean;
  /** The Mapbox access token, applied so mapbox-gl can fetch the style/tiles. */
  accessToken: string;
  /** Mapbox Standard import config, keyed by import id (e.g. `basemap`). */
  config?: Record<string, Record<string, unknown>>;
}

/**
 * A factory that constructs a map instance from constructor options. Defaults
 * to the real `mapboxgl.Map`; tests inject a fake that returns a
 * {@link MinimalMap} of mocks.
 */
export type MapFactory = (options: MapConstructorOptions) => MinimalMap;

/** Options for {@link MapManager.init}. */
export interface MapManagerInitOptions {
  /** The DOM element the map renders into. */
  container: HTMLElement;
  /** App config carrying the Tile_Provider API key (used to build the style). */
  config: AppConfig;
  /** Called once when the base map has loaded; dismisses the loading UI (Req 1.5). */
  onReady?: () => void;
  /**
   * Called at most once when the base map fails to load — either an `error`
   * event or the 15s watchdog timeout (Req 1.6, 18.1).
   */
  onTileFailure?: (reason: 'timeout' | 'error') => void;
  /**
   * Optional injection point for the map constructor. Defaults to the real
   * `mapboxgl.Map`. Tests pass a fake so the non-rendering lifecycle logic
   * can be exercised without WebGL.
   */
  mapFactory?: MapFactory;
}

/**
 * Default factory: constructs a real mapbox-gl map from a stock style URL.
 *
 * The Mapbox access token is passed via the constructor's `accessToken` option
 * (preferred over mutating the global `mapboxgl.accessToken`) so the token is
 * scoped to this map instance and there is no shared global mutation — this
 * keeps concurrent maps and tests clean. The token is never hardcoded; it
 * originates from {@link AppConfig.tileKey} (env, Group 1) and is threaded in
 * via {@link MapConstructorOptions.accessToken}.
 */
const defaultMapFactory: MapFactory = (options) =>
  new mapboxgl.Map({
    container: options.container,
    style: options.style,
    center: options.center,
    zoom: options.zoom,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    maxBounds: options.maxBounds,
    accessToken: options.accessToken,
    config: options.config,
    dragRotate: options.dragRotate,
    pitchWithRotate: options.pitchWithRotate,
    touchZoomRotate: options.touchZoomRotate,
  }) as unknown as MinimalMap;

/**
 * Wraps a single mapbox-gl map instance and its lifecycle. Create one per mounted
 * map container, call {@link init} once, and {@link destroy} on unmount.
 */
export class MapManager {
  private map: MinimalMap | null = null;
  /**
   * The container element passed to {@link init}, retained (additively) so
   * {@link frameOverview} can measure the viewport for aspect-ratio-aware
   * framing when the map itself does not expose `getContainer()`.
   */
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private watchdogId: ReturnType<typeof setTimeout> | null = null;
  /** Guards {@link onReady}/{@link onTileFailure} so the outcome fires at most once. */
  private settled = false;

  private onReady?: () => void;
  private onTileFailure?: (reason: 'timeout' | 'error') => void;

  private readonly minZoom = STYLE_MIN_ZOOM;
  private readonly maxZoom = STYLE_MAX_ZOOM;

  // Bound listeners retained so they can be removed on destroy.
  /** Whether the 3D view (tilt + Standard 3D objects) is currently on. */
  private view3D = false;
  /** Current Map Context presentation mode. Defaults to "nearby". */
  private mapContext: MapContext = 'nearby';

  private readonly handleLoad = (): void => {
    // Paint the outside-NCR visual mask FIRST, then remove 3D outside NCR. The
    // mask is added before onReady (before MapView installs any NCR layer), so
    // every BahaRoute NCR layer added later renders on top of it (Req 2).
    this.installNcrOutsideMask();
    this.installMetroManilaClip();
    this.settleReady();
    this.restoreRoutePreview();
  };
  private readonly handleStyleLoad = (): void => {
    this.restoreRoutePreview();
  };
  private readonly handleIdle = (): void => {
    if (!this.routePreviewActive) this.restoreRoutePreview();
  };
  private readonly handleError = (): void => this.settleFailure('error');

  /**
   * Initializes the map: constructs a mapbox-gl map pointed at the stock
   * BahaRoute style URL with the Mapbox access token from config, framed on a
   * sensible Metro Manila center + zoom so the FIRST paint is already
   * NCR-focused (Req 1.2, 1.3). The responsive OVERVIEW framing is then applied
   * by {@link frameOverview} on `load` (MapView calls it on ready). Starts the
   * 15s tile watchdog (Req 1.6) and attaches a ResizeObserver that keeps the
   * canvas sized to its container (Req 5.3).
   *
   * No `maxBounds`/hard clip is set, so the basemap keeps rendering beyond the
   * NCR and users can pan freely (Req 1.6).
   *
   * @returns The created map instance (also retained internally).
   */
  init(options: MapManagerInitOptions): MinimalMap {
    if (this.map) {
      throw new Error('MapManager.init called twice; create a new MapManager.');
    }

    this.onReady = options.onReady;
    this.onTileFailure = options.onTileFailure;

    const factory = options.mapFactory ?? defaultMapFactory;

    // The Mapbox access token flows from env → AppConfig.tileKey (Group 1) and
    // is applied at construction; it is never hardcoded (Req 17.1, 17.2).
    const accessToken = options.config.tileKey ?? '';

    const map = factory({
      container: options.container,
      style: bahaRouteStyleUrl(),
      // Start centered on Metro Manila so the first paint is NCR-focused; the
      // tuned overview center sits inside the NCR extent. frameOverview() then
      // applies the responsive framing on load.
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      // NCR-only presentation: constrain panning to a PADDED box around Metro
      // Manila so users cannot roam into the surrounding provinces, while the
      // edge LGUs stay inspectable (padding in METRO_MANILA_MAX_BOUNDS).
      maxBounds: METRO_MANILA_MAX_BOUNDS,
      // Full 360° rotation, discoverable via the on-screen compass and usable by
      // right-drag (desktop) / two-finger twist (touch).
      dragRotate: true,
      pitchWithRotate: true,
      touchZoomRotate: true,
      accessToken,
      // Standard: faded theme, day light, 3D hidden until set3D(true).
      config: { [STANDARD_BASEMAP_IMPORT_ID]: { ...BAHAROUTE_STANDARD_CONFIG } },
    });
    this.map = map;
    this.container = options.container;

    // Map load success clears the watchdog; error or timeout reports failure.
    map.on('load', this.handleLoad);
    map.on('style.load', this.handleStyleLoad);
    map.on('idle', this.handleIdle);
    map.on('error', this.handleError);

    this.startWatchdog();
    this.attachResizeObserver(options.container);

    return map;
  }

  /**
   * Animates the view back to {@link METRO_MANILA_EXTENT} (used by
   * RecenterControl, Req 7.2). No-op safe if called before init.
   *
   * @param durationMs - Animation duration in ms (default 800; within the
   *   1000ms budget of Req 7.2).
   */
  recenter(durationMs = 800): void {
    // fitBounds resets pitch to 0 unless given one, so keep the 3D tilt.
    this.map?.fitBounds(
      METRO_MANILA_EXTENT,
      this.view3D ? { duration: durationMs, pitch: VIEW_3D_PITCH } : { duration: durationMs },
    );
  }

  /**
   * Switches between the flat 2D view and the 3D view. 3D tilts the camera to
   * {@link VIEW_3D_PITCH} and shows Mapbox Standard's 3D objects (clipped to
   * Metro Manila on load); 2D flattens the camera and hides them. Keeps the
   * current center/zoom. Safe no-op before init / on fakes lacking the APIs.
   */
  set3D(on: boolean): void {
    this.view3D = on;
    const map = this.map;
    if (!map) return;
    try {
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'show3dObjects', on);
    } catch {
      // Style not ready or not Standard: the camera tilt below still applies.
    }
    map.easeTo?.({ pitch: on ? VIEW_3D_PITCH : 0, duration: VIEW_MODE_TRANSITION_MS });
  }

  /** True while the 3D view is on. */
  is3D(): boolean {
    return this.view3D;
  }

  /**
   * Switches the MAP CONTEXT presentation between the strict NCR-only view and
   * the nearby-areas view. This is a PRESENTATION-ONLY switch: it changes the
   * basemap label config, the outside-NCR visual mask, and the camera pan
   * constraint. It NEVER touches thematic data — Flood Risk, Historical,
   * Reports, Closures, and routing remain NCR-only regardless of context.
   *
   *  - `ncr-only` (default): outside-NCR mask visible, place/POI/transit labels
   *    hidden, camera constrained tightly to NCR.
   *  - `nearby`: mask hidden so surrounding Bulacan/Rizal/Cavite/Laguna context
   *    shows, place labels restored for orientation, camera constraint relaxed
   *    to the wider nearby box. NCR stays visually dominant via its own mask
   *    boundary/label layers (unchanged) and the initial framing.
   *
   * Safe no-op before init / on fakes lacking the style APIs.
   */
  setMapContext(context: MapContext): void {
    this.mapContext = context;
    const map = this.map;
    if (!map) return;
    const nearby = context === 'nearby';

    // 1) Basemap settlement/POI/transit labels: hidden in NCR-only, restored in
    //    nearby mode. Road labels always stay on.
    try {
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'showPlaceLabels', nearby);
      map.setConfigProperty?.(
        STANDARD_BASEMAP_IMPORT_ID,
        'showPointOfInterestLabels',
        nearby,
      );
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'showTransitLabels', nearby);
    } catch {
      // Style not ready / not Standard: mask + bounds below still apply.
    }

    // 2) Outside-NCR opaque mask: shown in NCR-only, hidden in nearby mode.
    try {
      if (map.getLayer?.(NCR_OUTSIDE_MASK_LAYER_ID) !== undefined) {
        map.setLayoutProperty?.(
          NCR_OUTSIDE_MASK_LAYER_ID,
          'visibility',
          nearby ? 'none' : 'visible',
        );
      }
    } catch {
      // Mask not installed yet (e.g. fake map): safe to ignore.
    }

    // 3) Camera pan constraint: tight NCR box vs. the wider nearby box.
    try {
      map.setMaxBounds?.(
        nearby ? METRO_MANILA_NEARBY_MAX_BOUNDS : METRO_MANILA_MAX_BOUNDS,
      );
    } catch {
      // Fake map without setMaxBounds: safe to ignore.
    }
  }

  /** The current Map Context presentation mode. */
  getMapContext(): MapContext {
    return this.mapContext;
  }

  // --- drive view (demo) ---------------------------------------------------

  /** 3D mode before the drive started, restored by {@link endDriveView}. */
  private preDrive3D: boolean | null = null;
  private driveBearing: number | null = null;
  private radiusCenter: [number, number] | null = null;
  private driveCamera: DriveCameraMode = 'follow';
  private driveRadius: DriveRadius = DRIVE_3D_RADIUS_M;

  /** Switches the drive camera preset; applied on the next update. */
  setDriveCamera(mode: DriveCameraMode): void {
    this.driveCamera = mode;
  }

  /** Changes the 3D radius around the vehicle and redraws the clip now. */
  setDriveRadius(radiusM: DriveRadius): void {
    this.driveRadius = radiusM;
    if (this.preDrive3D === null || !this.radiusCenter) return;
    try {
      this.map
        ?.getSource?.(DRIVE_RADIUS_SOURCE)
        ?.setData?.(outsideRadiusMask(this.radiusCenter, radiusM));
    } catch {
      // Source missing: ignore.
    }
  }

  /**
   * Enters the driver view: 3D on (trees off to save GPU), draws the route and
   * vehicle, and adds a clip that keeps 3D only within
   * {@link DRIVE_3D_RADIUS_M} of the vehicle (on top of the NCR-only clip).
   * Best-effort and no-op on maps lacking the style APIs.
   */
  startDriveView(
    route: ReadonlyArray<[number, number]>,
    markers: ReadonlyArray<DriveMarker> = [],
  ): void {
    const map = this.map;
    if (!map || this.preDrive3D !== null) return;
    this.preDrive3D = this.view3D;
    this.view3D = true;
    this.driveBearing = null;
    this.radiusCenter = route[0] ?? null;
    try {
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'show3dObjects', true);
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'show3dTrees', false);
    } catch {
      // Not Standard / style not ready: the follow camera still works.
    }
    if (typeof map.addSource !== 'function' || typeof map.addLayer !== 'function') return;
    try {
      map.addSource(DRIVE_ROUTE_SOURCE, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: route },
        },
      });
      map.addLayer({
        id: DRIVE_ROUTE_LAYER,
        type: 'line',
        slot: 'middle',
        source: DRIVE_ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': DRIVE_COLOR, 'line-width': 6, 'line-opacity': 0.75 },
      });
      if (route[0]) {
        map.addSource(DRIVE_RADIUS_SOURCE, {
          type: 'geojson',
          data: outsideRadiusMask(route[0], this.driveRadius),
        });
        map.addLayer({
          id: DRIVE_RADIUS_LAYER,
          type: 'clip',
          source: DRIVE_RADIUS_SOURCE,
          layout: { 'clip-layer-types': ['model'] },
        });
        if (markers.length > 0) {
          map.addSource(DRIVE_MARKERS_SOURCE, {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: markers.map((mk) => ({
                ...pointFeature(mk.position),
                properties: { color: mk.color, label: mk.label ?? '' },
              })),
            },
          });
          map.addLayer({
            id: DRIVE_MARKERS_LAYER,
            type: 'circle',
            slot: 'top',
            source: DRIVE_MARKERS_SOURCE,
            paint: {
              'circle-radius': 11,
              'circle-color': ['get', 'color'],
              'circle-opacity': 0.9,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
              'circle-pitch-alignment': 'map',
            },
          });
        }
        if (markers.length > 0) this.addDemoMarkerLabels(DRIVE_MARKERS_LABEL, DRIVE_MARKERS_SOURCE);
        map.addSource(DRIVE_CAR_SOURCE, { type: 'geojson', data: pointFeature(route[0]) });
        map.addLayer({
          id: DRIVE_CAR_LAYER,
          type: 'circle',
          slot: 'top',
          source: DRIVE_CAR_SOURCE,
          paint: {
            'circle-radius': 9,
            'circle-color': DRIVE_COLOR,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
            'circle-pitch-alignment': 'map',
          },
        });
      }
    } catch {
      // Overlays are best-effort; the camera follow still runs.
    }
  }

  /**
   * Moves the vehicle and the follow camera. The radius clip is only updated
   * every {@link DRIVE_RADIUS_UPDATE_M} meters to avoid per-frame reprocessing.
   */
  updateDrive({ position, bearing }: DriveUpdate): void {
    const map = this.map;
    if (!map || this.preDrive3D === null) return;

    // Smooth heading along the shortest angular direction.
    const prev = this.driveBearing ?? bearing;
    const delta = ((bearing - prev + 540) % 360) - 180;
    this.driveBearing = (prev + delta * DRIVE_BEARING_SMOOTHING + 360) % 360;

    const camera = DRIVE_CAMERAS[this.driveCamera];
    const height = this.measureViewport()?.height ?? 0;
    map.jumpTo?.({
      center: position,
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: this.driveBearing,
      padding: { top: Math.round(height * camera.topPaddingRatio), bottom: 0, left: 0, right: 0 },
    });
    try {
      map.getSource?.(DRIVE_CAR_SOURCE)?.setData?.(pointFeature(position));
      if (
        !this.radiusCenter ||
        distanceMeters(this.radiusCenter, position) >= DRIVE_RADIUS_UPDATE_M
      ) {
        this.radiusCenter = position;
        map
          .getSource?.(DRIVE_RADIUS_SOURCE)
          ?.setData?.(outsideRadiusMask(position, this.driveRadius));
      }
    } catch {
      // Source missing: keep following with the camera only.
    }
  }

  /** Replaces the route line while keeping flood markers at their reported locations. */
  setDriveRoute(route: ReadonlyArray<[number, number]>): void {
    if (this.preDrive3D === null) return;
    try {
      this.map?.getSource?.(DRIVE_ROUTE_SOURCE)?.setData?.({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route },
      });
    } catch {
      // Source missing: ignore.
    }
  }

  /** Leaves the driver view, removes its overlays, restores mode + overview. */
  endDriveView(): void {
    const map = this.map;
    if (!map || this.preDrive3D === null) return;
    const restore3D = this.preDrive3D;
    this.preDrive3D = null;
    this.driveBearing = null;
    this.radiusCenter = null;
    try {
      for (const id of [
        DRIVE_CAR_LAYER,
        DRIVE_MARKERS_LABEL,
        DRIVE_MARKERS_LAYER,
        DRIVE_RADIUS_LAYER,
        DRIVE_ROUTE_LAYER,
      ]) {
        if (map.getLayer?.(id)) map.removeLayer?.(id);
      }
      for (const id of [
        DRIVE_CAR_SOURCE,
        DRIVE_MARKERS_SOURCE,
        DRIVE_RADIUS_SOURCE,
        DRIVE_ROUTE_SOURCE,
      ]) {
        if (map.getSource?.(id)) map.removeSource?.(id);
      }
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'show3dTrees', true);
    } catch {
      // Cleanup is best-effort.
    }
    // Restore the pre-drive mode instantly, then animate back to the overview.
    this.view3D = restore3D;
    try {
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'show3dObjects', restore3D);
    } catch {
      // Ignore: style not Standard / not ready.
    }
    map.jumpTo?.({
      bearing: 0,
      pitch: restore3D ? VIEW_3D_PITCH : 0,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    this.frameOverview();
  }

  /** True while the driver view is active. */
  isDriving(): boolean {
    return this.preDrive3D !== null;
  }

  // --- camera pass-throughs (Milestone A, Req 1.2, 10.5) -------------------
  //
  // Additive, no-op-safe delegates so a future CameraController (Milestone D)
  // can drive framing through MapManager without duplicating it. Each guards
  // with `this.map?.method?.(...)` exactly like recenter(): if the map is null
  // (before init / after destroy) OR the underlying map lacks the method (e.g.
  // a minimal fake), the call is a silent no-op and never throws.

  /** Delegates to the underlying map's `flyTo`. Safe no-op if unavailable. */
  flyTo(options: unknown): void {
    this.map?.flyTo?.(options);
  }

  /** Delegates to the underlying map's `easeTo`. Safe no-op if unavailable. */
  easeTo(options: unknown): void {
    this.map?.easeTo?.(options);
  }

  /**
   * Monotonic camera-intent token. Each planning camera move (overview, origin
   * preview, both-points frame) bumps this; a move only runs if it still holds
   * the latest token, so an older async transition can never override a newer
   * requested state. Driver Mode uses its own per-frame `jumpTo` and is not
   * gated by this token.
   */
  private cameraToken = 0;

  /** Reserves and returns the next camera-intent token (see {@link cameraToken}). */
  nextCameraToken(): number {
    this.cameraToken += 1;
    return this.cameraToken;
  }

  /**
   * Smoothly focuses the map on a chosen ORIGIN for a 3D preview — center on the
   * point, zoom to street/neighborhood level, and tilt to a moderate 3D pitch.
   * This is an origin PREVIEW, not Driver Mode: no route-follow camera, no
   * per-frame movement. 3D objects are enabled if the style supports them so
   * buildings appear, while nearby roads stay visible. Bearing is left stable
   * (north) unless a caller supplies one.
   *
   * Guarded by {@link cameraToken}: if a newer camera intent has been requested
   * since `token` was reserved, this is a no-op (prevents stale overrides).
   */
  focusOrigin(
    origin: [number, number],
    token: number = this.nextCameraToken(),
    bearing = 0,
  ): void {
    const map = this.map;
    if (!map) return;
    if (token !== this.cameraToken) return; // superseded by a newer intent
    // Enable Standard 3D objects for the preview (best-effort).
    try {
      map.setConfigProperty?.(STANDARD_BASEMAP_IMPORT_ID, 'show3dObjects', true);
    } catch {
      // Not Standard / style not ready: the tilt below still applies.
    }
    this.view3D = true;
    const options = {
      center: origin,
      zoom: ORIGIN_PREVIEW_ZOOM,
      pitch: ORIGIN_PREVIEW_PITCH,
      bearing,
      duration: ORIGIN_PREVIEW_DURATION_MS,
      essential: true,
    };
    if (typeof map.flyTo === 'function') map.flyTo(options);
    else map.easeTo?.(options);
  }

  /**
   * Frames both trip points (origin + destination) in the viewport with a mild
   * 3D pitch — the route-planning camera after a destination is chosen. Returns
   * from the close origin preview to a two-point overview. Not Driver Mode.
   *
   * Guarded by {@link cameraToken} like {@link focusOrigin}.
   */
  framePoints(
    a: [number, number],
    b: [number, number],
    token: number = this.nextCameraToken(),
  ): void {
    const map = this.map;
    if (!map) return;
    if (token !== this.cameraToken) return;
    const bounds: [[number, number], [number, number]] = [
      [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
    ];
    this.view3D = true;
    try {
      map.fitBounds(bounds, {
        padding: PLAN_FRAME_PADDING,
        pitch: PLAN_FRAME_PITCH,
        duration: ORIGIN_PREVIEW_DURATION_MS,
      });
    } catch {
      // Fake map / fitBounds unavailable: safe no-op.
    }
  }

  // --- Route preview (pre-drive planning) ----------------------------------

  /** True while route-preview overlays are installed. */
  private routePreviewActive = false;
  private pendingRoutePreview: {
    routes: ReadonlyArray<PreviewRoute>;
    selectedId: string;
    ends: [[number, number], [number, number]];
  } | null = null;

  private restoreRoutePreview(): void {
    const preview = this.pendingRoutePreview;
    if (preview) this.showRoutePreview(preview.routes, preview.selectedId, preview.ends);
  }

  /** Draws a route line as a GeoJSON feature via a source's setData. */
  private setPreviewLine(
    sourceId: string,
    lines: ReadonlyArray<{ id: string; coords: ReadonlyArray<[number, number]> }>,
  ): void {
    const features = lines.map((line) => ({
      type: 'Feature' as const,
      // `routeId` lets a click on an alternative line resolve back to its route
      // so the map-line selection can sync with the route cards.
      id: line.id,
      properties: { routeId: line.id },
      geometry: {
        type: 'LineString' as const,
        coordinates: line.coords as [number, number][],
      },
    }));
    this.map?.getSource?.(sourceId)?.setData?.({
      type: 'FeatureCollection',
      features,
    });
  }

  /**
   * Shows the PRE-DRIVE route preview: the selected/recommended route is drawn
   * with strong emphasis, alternatives are drawn faded beneath it, and the
   * origin/destination end dots are shown. All relevant route geometry is fit
   * into the viewport at a MODERATE pitch (planning view — NOT the Driver Mode
   * camera). Safe no-op on maps lacking the style APIs (tests). Idempotent:
   * re-installs cleanly if called again.
   *
   * @param routes - Candidate routes (id + geometry).
   * @param selectedId - Which route id is currently selected/recommended.
   * @param ends - `[origin, destination]` end points for the markers.
   */
  showRoutePreview(
    routes: ReadonlyArray<PreviewRoute>,
    selectedId: string,
    ends: [[number, number], [number, number]],
  ): void {
    const map = this.map;
    if (!map || typeof map.addSource !== 'function' || typeof map.addLayer !== 'function') return;
    this.clearRoutePreview();
    if (routes.length === 0) return;
    this.pendingRoutePreview = { routes, selectedId, ends };
    if (map.isStyleLoaded?.() === false) return;
    try {
      // Alternatives first (drawn beneath), then the selected route on top.
      // `promoteId: routeId` makes the clicked alt feature's id its routeId so a
      // map-line click can select that route (synced with the cards).
      map.addSource(PREVIEW_ALT_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'routeId',
      });
      map.addLayer({
        id: PREVIEW_ALT_LAYER,
        type: 'line',
        slot: 'top',
        source: PREVIEW_ALT_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // A slightly wider transparent hit area is not needed; the 5px line is
        // clickable. Keep the muted styling so the selected line dominates.
        paint: { 'line-color': PREVIEW_ALT_COLOR, 'line-width': 6, 'line-opacity': 0.8 },
      });
      map.addSource(PREVIEW_SEL_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: PREVIEW_SEL_CASING,
        type: 'line',
        slot: 'top',
        source: PREVIEW_SEL_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 1 },
      });
      map.addLayer({
        id: PREVIEW_SEL_LAYER,
        type: 'line',
        slot: 'top',
        source: PREVIEW_SEL_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PREVIEW_SELECTED_COLOR, 'line-width': 8, 'line-opacity': 1 },
      });
      map.addSource(PREVIEW_ENDS_SOURCE, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: ends.map((p) => pointFeature(p)),
        },
      });
      map.addLayer({
        id: PREVIEW_ENDS_LAYER,
        type: 'circle',
        slot: 'top',
        source: PREVIEW_ENDS_SOURCE,
        paint: {
          'circle-radius': 7,
          'circle-color': PREVIEW_SELECTED_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      });
      map.addSource(PREVIEW_FLOODS_SOURCE, {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: PREVIEW_FLOODS_LAYER, type: 'circle', slot: 'top', source: PREVIEW_FLOODS_SOURCE,
        paint: { 'circle-radius': 10, 'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
      });
      this.addDemoMarkerLabels(PREVIEW_FLOODS_LABEL, PREVIEW_FLOODS_SOURCE);
      this.routePreviewActive = true;
      this.updateRoutePreviewSelection(routes, selectedId);
      this.frameRoutePreview(routes, ends);
    } catch {
      // Overlays are best-effort; planning still works via the cards.
    }
  }

  /**
   * Re-emphasizes the preview: the given route becomes the dominant line, the
   * rest fade. Called when the user selects a different route card / line.
   */
  updateRoutePreviewSelection(routes: ReadonlyArray<PreviewRoute>, selectedId: string): void {
    if (this.pendingRoutePreview) {
      this.pendingRoutePreview = { ...this.pendingRoutePreview, routes, selectedId };
    }
    if (!this.routePreviewActive) return;
    const selected = routes.find((r) => r.id === selectedId);
    const alternatives = routes.filter((r) => r.id !== selected?.id);
    try {
      const floodSource = this.map?.getSource?.(PREVIEW_FLOODS_SOURCE) as { setData?: (data: unknown) => void } | undefined;
      floodSource?.setData?.({
        type: 'FeatureCollection',
        features: (selected?.markers ?? []).map((marker) => ({
          ...pointFeature(marker.position),
          properties: { color: marker.color, label: marker.label ?? '' },
        })),
      });
      this.setPreviewLine(PREVIEW_SEL_SOURCE, selected ? [
        { id: selected.id, coords: selected.geometry },
      ] : []);
      this.setPreviewLine(
        PREVIEW_ALT_SOURCE,
        alternatives.map((r) => ({ id: r.id, coords: r.geometry })),
      );
    } catch {
      // Source missing (e.g. fake map): ignore.
    }
  }

  /** Fits all preview route geometry + endpoints into view at a moderate pitch. */
  private frameRoutePreview(
    routes: ReadonlyArray<PreviewRoute>,
    ends: [[number, number], [number, number]],
  ): void {
    const map = this.map;
    if (!map) return;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const consider = (p: readonly [number, number]): void => {
      minLng = Math.min(minLng, p[0]);
      minLat = Math.min(minLat, p[1]);
      maxLng = Math.max(maxLng, p[0]);
      maxLat = Math.max(maxLat, p[1]);
    };
    for (const r of routes) for (const p of r.geometry) consider(p);
    consider(ends[0]);
    consider(ends[1]);
    if (!Number.isFinite(minLng)) return;
    try {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        {
          padding: PLAN_FRAME_PADDING,
          pitch: PLAN_FRAME_PITCH,
          duration: ORIGIN_PREVIEW_DURATION_MS,
        },
      );
    } catch {
      // fitBounds unavailable: safe no-op.
    }
  }

  /** Removes the route-preview overlays (before Driver Mode or on cancel). */
  clearRoutePreview(): void {
    this.pendingRoutePreview = null;
    const map = this.map;
    if (!map) return;
    try {
      for (const id of [PREVIEW_FLOODS_LABEL, PREVIEW_FLOODS_LAYER, PREVIEW_ENDS_LAYER, PREVIEW_SEL_LAYER, PREVIEW_SEL_CASING, PREVIEW_ALT_LAYER]) {
        if (map.getLayer?.(id)) map.removeLayer?.(id);
      }
      for (const id of [PREVIEW_FLOODS_SOURCE, PREVIEW_ENDS_SOURCE, PREVIEW_SEL_SOURCE, PREVIEW_ALT_SOURCE]) {
        if (map.getSource?.(id)) map.removeSource?.(id);
      }
    } catch {
      // Best-effort cleanup.
    }
    this.routePreviewActive = false;
  }

  private addDemoMarkerLabels(id: string, source: string): void {
    this.map?.addLayer?.({
      id, source, type: 'symbol', slot: 'top',
      layout: { 'text-field': ['get', 'label'], 'text-size': 12,
        'text-anchor': 'top', 'text-offset': [0, 1.2], 'text-allow-overlap': true },
      paint: { 'text-color': '#172554', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
  }

  /** True while the route preview overlays are shown. */
  isRoutePreviewActive(): boolean {
    return this.routePreviewActive;
  }

  /**
   * Binds a click handler on the ALTERNATIVE route lines so clicking an
   * alternative on the map selects that route (synced with the route cards).
   * The clicked feature's id is its `routeId` (via `promoteId`). Returns a
   * teardown fn. Safe no-op on maps lacking layer-scoped click events (tests).
   *
   * @param onSelect - Called with the clicked route id.
   */
  onRoutePreviewSelect(onSelect: (routeId: string) => void): () => void {
    const map = this.map as unknown as {
      on?: (t: string, layer: string, l: (e: unknown) => void) => void;
      off?: (t: string, layer: string, l: (e: unknown) => void) => void;
      getCanvas?: () => { style: { cursor: string } };
    } | null;
    if (!map || typeof map.on !== 'function') return () => undefined;

    const onClick = (e: unknown): void => {
      const ev = e as {
        features?: Array<{ id?: string | number; properties?: { routeId?: string } }>;
      };
      const f = ev.features?.[0];
      const id =
        (typeof f?.id === 'string' && f.id) ||
        (typeof f?.properties?.routeId === 'string' && f.properties.routeId) ||
        null;
      if (id) onSelect(id);
    };
    const setCursor = (c: string): void => {
      const canvas = map.getCanvas?.();
      if (canvas) canvas.style.cursor = c;
    };
    const onEnter = (): void => setCursor('pointer');
    const onLeave = (): void => setCursor('');

    map.on('click', PREVIEW_ALT_LAYER, onClick);
    map.on('mouseenter', PREVIEW_ALT_LAYER, onEnter);
    map.on('mouseleave', PREVIEW_ALT_LAYER, onLeave);
    return () => {
      map.off?.('click', PREVIEW_ALT_LAYER, onClick);
      map.off?.('mouseenter', PREVIEW_ALT_LAYER, onEnter);
      map.off?.('mouseleave', PREVIEW_ALT_LAYER, onLeave);
    };
  }

  /** Delegates to the underlying map's `setPitch`. Safe no-op if unavailable. */
  setPitch(pitch: number): void {
    this.map?.setPitch?.(pitch);
  }

  /** Delegates to the underlying map's `setBearing`. Safe no-op if unavailable. */
  setBearing(bearing: number): void {
    this.map?.setBearing?.(bearing);
  }

  /** The current map bearing in degrees [0, 360). 0 (north) when unavailable. */
  getBearing(): number {
    const raw = this.map?.getBearing?.() ?? 0;
    return ((raw % 360) + 360) % 360;
  }

  /**
   * Rotates the map by `deltaDeg` degrees (positive = clockwise) with a short
   * animation, wrapping across the full 360° range. Used by the on-screen
   * rotate/compass control. Safe no-op before init / on fakes lacking easeTo.
   *
   * @param deltaDeg - Signed rotation delta in degrees.
   * @param durationMs - Animation duration (default 300ms).
   */
  rotateBy(deltaDeg: number, durationMs = 300): void {
    const map = this.map;
    if (!map) return;
    const next = this.getBearing() + deltaDeg;
    if (typeof map.easeTo === 'function') {
      map.easeTo({ bearing: next, duration: durationMs });
    } else {
      map.setBearing?.(next);
    }
  }

  /**
   * Animates the map back to north (bearing 0). Used by the compass "reset
   * north" affordance. Safe no-op before init / on fakes lacking easeTo.
   */
  resetNorth(durationMs = 300): void {
    const map = this.map;
    if (!map) return;
    if (typeof map.easeTo === 'function') {
      map.easeTo({ bearing: 0, duration: durationMs });
    } else {
      map.setBearing?.(0);
    }
  }

  /**
   * Frames the tuned NCR overview (Req 1.2), aspect-ratio-aware.
   *
   * Measures the map container (via the map's `getContainer()` if present, else
   * the container ref held from {@link init}) and delegates the *decision* to
   * the pure {@link computeOverviewFraming}:
   *  - `fitBounds` (narrow / portrait / mobile, or when no usable size is
   *    measurable — e.g. jsdom fakes) → `fitBounds(OVERVIEW_BOUNDS,
   *    overviewFitOptions())`, exactly the prior behavior, so Milestone 1 tests
   *    and mobile keep working.
   *  - `centerZoom` (wide desktop) → `easeTo({ center, zoom, duration })` so the
   *    NCR width fills the screen and the NCR appears LARGER (not more padded).
   *    Falls back to a fitBounds framing when `easeTo` is unavailable.
   *
   * Distinct from {@link recenter} (which fits {@link METRO_MANILA_EXTENT}) and
   * from init's constructor center+zoom framing, both unchanged. Safe no-op before
   * init / after destroy. No maxBounds is ever set (no hard clip, Req 1.6).
   */
  frameOverview(): void {
    const map = this.map;
    if (!map) return;

    const size = this.measureViewport();
    // No usable size (e.g. an unlaid-out container or a minimal jsdom fake):
    // keep the proven fitBounds framing.
    if (!size) {
      map.fitBounds(OVERVIEW_BOUNDS, overviewFitOptions());
      return;
    }

    const framing = computeOverviewFraming(size);
    if (framing.mode === 'centerZoom') {
      if (typeof map.easeTo === 'function') {
        map.easeTo({
          center: framing.center,
          zoom: framing.zoom,
          duration: framing.duration,
        });
      } else {
        // No easeTo (e.g. a fake without it): fall back to fitBounds framing
        // rather than throwing.
        map.fitBounds(OVERVIEW_BOUNDS, overviewFitOptions());
      }
      return;
    }

    map.fitBounds(framing.bounds, {
      padding: framing.padding,
      duration: framing.duration,
    });
  }

  /**
   * Best-effort measurement of the current map container in CSS pixels. Prefers
   * the map's own `getContainer()` (the real Mapbox map has it), else the
   * container ref captured in {@link init}. Returns `null` when no positive
   * `{ width, height }` can be read (e.g. jsdom fakes with zero-size elements),
   * signaling {@link frameOverview} to use the fitBounds fallback.
   */
  private measureViewport(): { width: number; height: number } | null {
    const el =
      (typeof this.map?.getContainer === 'function'
        ? this.map.getContainer()
        : null) ?? this.container;
    if (!el) return null;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  }

  /**
   * Sets the zoom, clamped to the style's `[minZoom, maxZoom]` bounds so zoom
   * controls never exceed the bounds or enter an error state (Req 5.2, 5.5).
   */
  setZoomClamped(zoom: number): void {
    if (!this.map) return;
    this.map.setZoom(this.clampZoom(zoom));
  }

  /** Zoom in by `delta` (default 1), clamped to the style max (Req 5.5). */
  zoomIn(delta = 1): void {
    if (!this.map) return;
    this.setZoomClamped(this.map.getZoom() + delta);
  }

  /** Zoom out by `delta` (default 1), clamped to the style min (Req 5.5). */
  zoomOut(delta = 1): void {
    if (!this.map) return;
    this.setZoomClamped(this.map.getZoom() - delta);
  }

  /** Clamps a zoom value into the style's `[minZoom, maxZoom]` range. */
  clampZoom(zoom: number): number {
    if (Number.isNaN(zoom)) return this.minZoom;
    return Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }

  /** The underlying map instance, or null before init / after destroy. */
  getMap(): MinimalMap | null {
    return this.map;
  }

  /**
   * Releases all resources: removes the map (freeing WebGL context),
   * disconnects the ResizeObserver, clears the watchdog timer, and detaches
   * listeners. Always safe to call, and idempotent (design → lifecycle rules).
   */
  destroy(): void {
    this.clearWatchdog();
    this.preDrive3D = null;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.map) {
      this.map.off('load', this.handleLoad);
      this.map.off('style.load', this.handleStyleLoad);
      this.map.off('idle', this.handleIdle);
      this.map.off('error', this.handleError);
      this.map.remove();
      this.map = null;
    }

    this.container = null;
    this.pendingRoutePreview = null;
    this.routePreviewActive = false;
  }

  // --- internal ------------------------------------------------------------

  /**
   * Adds a Mapbox `clip` layer that removes 3D buildings and instanced models
   * (trees) everywhere OUTSIDE the 17 NCR cities, so the 3D view renders only
   * for Metro Manila. Best-effort: skipped on fakes without style APIs, and a
   * failure never blocks the map from becoming ready.
   */
  private installMetroManilaClip(): void {
    const map = this.map;
    if (!map || typeof map.addSource !== 'function' || typeof map.addLayer !== 'function') {
      return;
    }
    try {
      if (map.getLayer?.(NCR_CLIP_LAYER_ID)) return;
      map.addSource(NCR_CLIP_SOURCE_ID, {
        type: 'geojson',
        data: buildMetroManilaClipMask(metroManilaCityBoundaries),
      });
      map.addLayer({
        id: NCR_CLIP_LAYER_ID,
        type: 'clip',
        source: NCR_CLIP_SOURCE_ID,
        layout: { 'clip-layer-types': ['model'] },
      });
    } catch {
      // Clip is an enhancement; the base map stays usable without it.
    }
  }

  /**
   * Adds the outside-NCR VISUAL mask: a single light-neutral fill covering
   * everything outside the 17 LGUs so surrounding provinces/cities no longer
   * compete with Metro Manila, while NCR roads/labels/coastline stay visible.
   * Best-effort: skipped on fakes without style APIs; failure never blocks
   * readiness. Added before any NCR layer so it never covers BahaRoute content
   * and (being a plain fill with no registered handlers) never intercepts NCR
   * feature clicks.
   */
  private installNcrOutsideMask(): void {
    const map = this.map;
    if (!map) return;
    try {
      installNcrOutsideMask(map as unknown as MaskMapAdapter);
    } catch {
      // Visual mask is an enhancement; the base map stays usable without it.
    }
  }

  /** Starts the single 15s tile watchdog (Req 1.6). */
  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdogId = setTimeout(() => {
      this.watchdogId = null;
      this.settleFailure('timeout');
    }, TILE_WATCHDOG_MS);
  }

  /** Clears the watchdog timer if pending. Always called on settle/destroy. */
  private clearWatchdog(): void {
    if (this.watchdogId !== null) {
      clearTimeout(this.watchdogId);
      this.watchdogId = null;
    }
  }

  /** Marks a successful load exactly once and clears the watchdog. */
  private settleReady(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearWatchdog();
    this.onReady?.();
  }

  /** Reports a load failure exactly once and clears the watchdog. */
  private settleFailure(reason: 'timeout' | 'error'): void {
    if (this.settled) return;
    this.settled = true;
    this.clearWatchdog();
    this.onTileFailure?.(reason);
  }

  /**
   * Attaches a ResizeObserver on the container that resizes the map so it fills
   * its container without distortion (Req 5.3). Guarded for environments (like
   * jsdom) that do not provide ResizeObserver.
   */
  private attachResizeObserver(container: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.map?.resize();
    });
    this.resizeObserver.observe(container);
  }
}
