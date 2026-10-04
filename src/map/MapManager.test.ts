// src/map/MapManager.test.ts
//
// Unit tests for MapManager's non-rendering lifecycle logic. A fake map is
// injected via `mapFactory` so none of this exercises a real WebGL map (the
// test environment is jsdom, which has no WebGL). Requirements 1.2, 1.3, 1.6,
// 5.2, 5.3, 5.5.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MapManager,
  TILE_WATCHDOG_MS,
  VIEW_3D_PITCH,
  DRIVE_CAMERAS,
  DRIVE_PITCH,
  DRIVE_ZOOM,
  type MapConstructorOptions,
  type MinimalMap,
} from './MapManager';
import { NCR_CLIP_LAYER_ID, NCR_CLIP_SOURCE_ID } from './metroManilaClipMask';
import { NCR_OUTSIDE_MASK_LAYER_ID } from './ncrOutsideMask';
import {
  METRO_MANILA_EXTENT,
  METRO_MANILA_MAX_BOUNDS,
  METRO_MANILA_NEARBY_MAX_BOUNDS,
  isWithinMetroManila,
} from './metroManilaExtent';
import {
  BAHAROUTE_MAPBOX_STYLE_URL,
  BAHAROUTE_STANDARD_CONFIG,
  STYLE_MAX_ZOOM,
  STYLE_MIN_ZOOM,
} from './basemap/BahaRouteStyle';
import {
  OVERVIEW_BOUNDS,
  OVERVIEW_DESKTOP_CENTER,
  OVERVIEW_DESKTOP_ZOOM,
  overviewFitOptions,
} from '../camera/overviewFraming';
import type { AppConfig } from '../types/config';

const CONFIG: AppConfig = { tileKey: 'test-key-123', hasTileKey: true, demoMode: false };

/** A fake MinimalMap whose event listeners can be triggered from tests. */
interface FakeMap extends MinimalMap {
  /** Emits an event to all registered listeners (mimics Mapbox GL JS's `on`). */
  emit(type: string, ...args: unknown[]): void;
  /** Captured constructor options passed to the factory. */
  __options: MapConstructorOptions;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  fitBounds: ReturnType<typeof vi.fn>;
  getZoom: ReturnType<typeof vi.fn>;
  setZoom: ReturnType<typeof vi.fn>;
}

/** Builds a fake map + a factory that returns it, tracking listeners/zoom. */
function makeFake(initialZoom = 12): {
  map: FakeMap;
  factory: (o: MapConstructorOptions) => MinimalMap;
} {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  let zoom = initialZoom;

  const map = {
    __options: undefined as unknown as MapConstructorOptions,
    on: vi.fn((type: string, listener: (...a: unknown[]) => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    }),
    off: vi.fn((type: string, listener: (...a: unknown[]) => void) => {
      const arr = listeners.get(type) ?? [];
      listeners.set(
        type,
        arr.filter((l) => l !== listener),
      );
    }),
    remove: vi.fn(),
    resize: vi.fn(),
    fitBounds: vi.fn(),
    getZoom: vi.fn(() => zoom),
    setZoom: vi.fn((z: number) => {
      zoom = z;
    }),
    emit(type: string, ...args: unknown[]) {
      for (const l of listeners.get(type) ?? []) l(...args);
    },
  } as unknown as FakeMap;

  const factory = (o: MapConstructorOptions): MinimalMap => {
    map.__options = o;
    return map;
  };

  return { map, factory };
}

describe('MapManager.init framing (Req 1.2, 1.3)', () => {
  it('constructs the map with the stock Mapbox style URL, style zoom bounds, and the config token', () => {
    const { map, factory } = makeFake();
    const mgr = new MapManager();
    const container = document.createElement('div');

    mgr.init({ container, config: CONFIG, mapFactory: factory });

    expect(map.__options.style).toBe(BAHAROUTE_MAPBOX_STYLE_URL);
    expect(map.__options.minZoom).toBe(STYLE_MIN_ZOOM);
    expect(map.__options.maxZoom).toBe(STYLE_MAX_ZOOM);
    expect(map.__options.container).toBe(container);
    // The Mapbox access token flows from AppConfig.tileKey (env), never hardcoded.
    expect(map.__options.accessToken).toBe(CONFIG.tileKey);
    // NCR-only presentation: the constructor constrains panning to the padded
    // NCR maxBounds so users cannot roam into surrounding provinces.
    expect(
      (map.__options as unknown as { maxBounds?: unknown }).maxBounds,
    ).toEqual(METRO_MANILA_MAX_BOUNDS);
    // The padded bounds must still contain the full framing extent so the edge
    // LGUs stay inspectable (padding extends beyond every NCR edge).
    const [[mbW, mbS], [mbE, mbN]] = METRO_MANILA_MAX_BOUNDS;
    const [[exW, exS], [exE, exN]] = METRO_MANILA_EXTENT;
    expect(mbW).toBeLessThan(exW);
    expect(mbS).toBeLessThan(exS);
    expect(mbE).toBeGreaterThan(exE);
    expect(mbN).toBeGreaterThan(exN);

    mgr.destroy();
  });

  it('frames a first-paint center that is inside the NCR at a zoom within the style bounds', () => {
    const { map, factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    const [centerLng, centerLat] = map.__options.center;
    expect(isWithinMetroManila(centerLng, centerLat)).toBe(true);
    expect(map.__options.zoom).toBeGreaterThanOrEqual(STYLE_MIN_ZOOM);
    expect(map.__options.zoom).toBeLessThanOrEqual(STYLE_MAX_ZOOM);

    mgr.destroy();
  });
});

describe('MapManager tile watchdog (Req 1.6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onTileFailure after 15s when no load event arrives', () => {
    const { factory } = makeFake();
    const onReady = vi.fn();
    const onTileFailure = vi.fn();
    const mgr = new MapManager();

    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      onReady,
      onTileFailure,
      mapFactory: factory,
    });

    expect(onTileFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TILE_WATCHDOG_MS);

    expect(onTileFailure).toHaveBeenCalledTimes(1);
    expect(onTileFailure).toHaveBeenCalledWith('timeout');
    expect(onReady).not.toHaveBeenCalled();

    mgr.destroy();
  });

  it('does NOT fire onTileFailure when a load event arrives first, and fires onReady once', () => {
    const { map, factory } = makeFake();
    const onReady = vi.fn();
    const onTileFailure = vi.fn();
    const mgr = new MapManager();

    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      onReady,
      onTileFailure,
      mapFactory: factory,
    });

    map.emit('load');
    expect(onReady).toHaveBeenCalledTimes(1);

    // Advancing past the watchdog window must not trigger a failure: the
    // watchdog was cleared on success and the outcome fires at most once.
    vi.advanceTimersByTime(TILE_WATCHDOG_MS * 2);
    expect(onTileFailure).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);

    mgr.destroy();
  });

  it('fires onTileFailure once on an error event and not again on timeout', () => {
    const { map, factory } = makeFake();
    const onTileFailure = vi.fn();
    const mgr = new MapManager();

    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      onTileFailure,
      mapFactory: factory,
    });

    map.emit('error', new Error('tile boom'));
    expect(onTileFailure).toHaveBeenCalledTimes(1);
    expect(onTileFailure).toHaveBeenCalledWith('error');

    vi.advanceTimersByTime(TILE_WATCHDOG_MS * 2);
    expect(onTileFailure).toHaveBeenCalledTimes(1);

    mgr.destroy();
  });

  it('does not fire onReady after destroy even if the watchdog would have elapsed', () => {
    const { factory } = makeFake();
    const onTileFailure = vi.fn();
    const mgr = new MapManager();

    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      onTileFailure,
      mapFactory: factory,
    });

    mgr.destroy();
    vi.advanceTimersByTime(TILE_WATCHDOG_MS * 2);
    expect(onTileFailure).not.toHaveBeenCalled();
  });
});

describe('MapManager.destroy releases resources', () => {
  it('removes the map, detaches listeners, and clears the watchdog', () => {
    vi.useFakeTimers();
    const { map, factory } = makeFake();
    const onTileFailure = vi.fn();
    const mgr = new MapManager();

    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      onTileFailure,
      mapFactory: factory,
    });

    mgr.destroy();

    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(map.off).toHaveBeenCalledWith('load', expect.any(Function));
    expect(map.off).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mgr.getMap()).toBeNull();

    // Timer cleared: advancing does not invoke the failure callback.
    vi.advanceTimersByTime(TILE_WATCHDOG_MS * 2);
    expect(onTileFailure).not.toHaveBeenCalled();

    // destroy is idempotent.
    expect(() => mgr.destroy()).not.toThrow();
    expect(map.remove).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('disconnects the ResizeObserver when available', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    const originalRO = globalThis.ResizeObserver;
    // Provide a fake ResizeObserver for this test.
    globalThis.ResizeObserver = vi.fn(() => ({
      observe,
      disconnect,
      unobserve: vi.fn(),
    })) as unknown as typeof ResizeObserver;

    try {
      const { factory } = makeFake();
      const mgr = new MapManager();
      const container = document.createElement('div');
      mgr.init({ container, config: CONFIG, mapFactory: factory });

      expect(observe).toHaveBeenCalledWith(container);
      mgr.destroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });

  it('resizes the map when the ResizeObserver fires', () => {
    let capturedCallback: (() => void) | undefined;
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = vi.fn((cb: () => void) => {
      capturedCallback = cb;
      return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    }) as unknown as typeof ResizeObserver;

    try {
      const { map, factory } = makeFake();
      const mgr = new MapManager();
      mgr.init({
        container: document.createElement('div'),
        config: CONFIG,
        mapFactory: factory,
      });

      capturedCallback?.();
      expect(map.resize).toHaveBeenCalled();
      mgr.destroy();
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });
});

describe('MapManager zoom clamping (Req 5.2, 5.5)', () => {
  it('clampZoom keeps values within [min, max]', () => {
    const { factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    expect(mgr.clampZoom(STYLE_MAX_ZOOM + 5)).toBe(STYLE_MAX_ZOOM);
    expect(mgr.clampZoom(STYLE_MIN_ZOOM - 5)).toBe(STYLE_MIN_ZOOM);
    expect(mgr.clampZoom(12)).toBe(12);
    expect(mgr.clampZoom(Number.NaN)).toBe(STYLE_MIN_ZOOM);

    mgr.destroy();
  });

  it('zoomIn / zoomOut / setZoomClamped never exceed the style bounds', () => {
    const { map, factory } = makeFake(STYLE_MAX_ZOOM);
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    // Already at max: zooming in stays clamped at max.
    mgr.zoomIn();
    expect(map.setZoom).toHaveBeenLastCalledWith(STYLE_MAX_ZOOM);

    // Explicit over-max request is clamped.
    mgr.setZoomClamped(STYLE_MAX_ZOOM + 10);
    expect(map.setZoom).toHaveBeenLastCalledWith(STYLE_MAX_ZOOM);

    // Drive below min: clamps to min.
    mgr.setZoomClamped(STYLE_MIN_ZOOM); // getZoom now returns min
    mgr.zoomOut();
    expect(map.setZoom).toHaveBeenLastCalledWith(STYLE_MIN_ZOOM);

    mgr.destroy();
  });
});

describe('MapManager.recenter (Req 7.2)', () => {
  it('fitBounds back to METRO_MANILA_EXTENT within the animation budget', () => {
    const { map, factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    mgr.recenter();
    expect(map.fitBounds).toHaveBeenCalledWith(
      METRO_MANILA_EXTENT,
      expect.objectContaining({ duration: expect.any(Number) }),
    );
    const [, options] = map.fitBounds.mock.calls[0] as [
      unknown,
      { duration: number },
    ];
    expect(options.duration).toBeLessThanOrEqual(1000);

    mgr.destroy();
  });
});

// --- Task 2 camera extensions (Req 1.2, 10.5) ------------------------------
//
// These fakes extend the minimal map with the optional camera methods so we can
// assert MapManager delegates with the exact args, and separately prove that a
// map OMITTING those methods keeps the delegates a safe no-op (never throws).

/** A fake map that ADDS the optional camera methods as spies. */
interface CameraFakeMap extends FakeMap {
  flyTo: ReturnType<typeof vi.fn>;
  easeTo: ReturnType<typeof vi.fn>;
  setPitch: ReturnType<typeof vi.fn>;
  setBearing: ReturnType<typeof vi.fn>;
}

/** Builds a fake with camera methods present + a factory returning it. */
function makeCameraFake(): {
  map: CameraFakeMap;
  factory: (o: MapConstructorOptions) => MinimalMap;
} {
  const { map, factory } = makeFake();
  const cameraMap = map as CameraFakeMap & { getBearing: ReturnType<typeof vi.fn> };
  cameraMap.flyTo = vi.fn();
  cameraMap.easeTo = vi.fn();
  cameraMap.setPitch = vi.fn();
  cameraMap.setBearing = vi.fn();
  cameraMap.getBearing = vi.fn(() => 0);
  return { map: cameraMap, factory };
}

describe('MapManager camera extensions (Req 1.2, 10.5)', () => {
  it('delegates flyTo/easeTo/setPitch/setBearing to the underlying map with the right args', () => {
    const { map, factory } = makeCameraFake();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    const flyOptions = { center: [121, 14.6], zoom: 17 };
    const easeOptions = { pitch: 50, duration: 500 };
    mgr.flyTo(flyOptions);
    mgr.easeTo(easeOptions);
    mgr.setPitch(45);
    mgr.setBearing(90);

    expect(map.flyTo).toHaveBeenCalledTimes(1);
    expect(map.flyTo).toHaveBeenCalledWith(flyOptions);
    expect(map.easeTo).toHaveBeenCalledTimes(1);
    expect(map.easeTo).toHaveBeenCalledWith(easeOptions);
    expect(map.setPitch).toHaveBeenCalledTimes(1);
    expect(map.setPitch).toHaveBeenCalledWith(45);
    expect(map.setBearing).toHaveBeenCalledTimes(1);
    expect(map.setBearing).toHaveBeenCalledWith(90);

    mgr.destroy();
  });

  it('is a safe no-op when the underlying map omits the camera methods', () => {
    // makeFake() produces a minimal map WITHOUT flyTo/easeTo/setPitch/setBearing.
    const { factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    expect(() => mgr.flyTo({ center: [121, 14.6] })).not.toThrow();
    expect(() => mgr.easeTo({ pitch: 50 })).not.toThrow();
    expect(() => mgr.setPitch(45)).not.toThrow();
    expect(() => mgr.setBearing(90)).not.toThrow();

    mgr.destroy();
  });

  it('is a safe no-op before init and after destroy', () => {
    const mgr = new MapManager();
    // Before init: map is null.
    expect(() => mgr.flyTo({})).not.toThrow();
    expect(() => mgr.easeTo({})).not.toThrow();
    expect(() => mgr.setPitch(0)).not.toThrow();
    expect(() => mgr.setBearing(0)).not.toThrow();
    expect(() => mgr.frameOverview()).not.toThrow();

    const { factory } = makeCameraFake();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });
    mgr.destroy();

    // After destroy: map is null again.
    expect(() => mgr.flyTo({})).not.toThrow();
    expect(() => mgr.frameOverview()).not.toThrow();
  });
});

describe('MapManager rotation (360°)', () => {
  function initRotateFake() {
    const { map, factory } = makeCameraFake();
    const m = map as CameraFakeMap & { getBearing: ReturnType<typeof vi.fn> };
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });
    return { map: m, mgr };
  }

  it('enables rotation gestures at construction', () => {
    const { map, mgr } = initRotateFake();
    const opts = map.__options as unknown as {
      dragRotate?: boolean;
      pitchWithRotate?: boolean;
      touchZoomRotate?: boolean;
    };
    expect(opts.dragRotate).toBe(true);
    expect(opts.pitchWithRotate).toBe(true);
    expect(opts.touchZoomRotate).toBe(true);
    mgr.destroy();
  });

  it('rotateBy eases the bearing by the delta (clockwise + counter-clockwise)', () => {
    const { map, mgr } = initRotateFake();
    map.getBearing.mockReturnValue(0);
    mgr.rotateBy(45);
    expect(map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ bearing: 45 }),
    );
    map.getBearing.mockReturnValue(45);
    mgr.rotateBy(-90);
    expect(map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ bearing: -45 }),
    );
    mgr.destroy();
  });

  it('getBearing normalizes into [0, 360)', () => {
    const { map, mgr } = initRotateFake();
    map.getBearing.mockReturnValue(-90);
    expect(mgr.getBearing()).toBe(270);
    map.getBearing.mockReturnValue(450);
    expect(mgr.getBearing()).toBe(90);
    mgr.destroy();
  });

  it('resetNorth eases the bearing back to 0', () => {
    const { map, mgr } = initRotateFake();
    mgr.resetNorth();
    expect(map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ bearing: 0 }),
    );
    mgr.destroy();
  });

  it('rotation methods are safe no-ops before init', () => {
    const mgr = new MapManager();
    expect(() => mgr.rotateBy(45)).not.toThrow();
    expect(() => mgr.resetNorth()).not.toThrow();
    expect(mgr.getBearing()).toBe(0);
  });
});

/**
 * Stamps fixed clientWidth/clientHeight onto an element so jsdom (which reports
 * 0 for both by default) can simulate a laid-out container of a given size.
 */
function sizedContainer(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', {
    value: height,
    configurable: true,
  });
  return el;
}

describe('MapManager.frameOverview (Req 1.2)', () => {
  it('falls back to fitBounds(OVERVIEW_BOUNDS) when the container has no measurable size', () => {
    // The default jsdom container reports clientWidth/clientHeight = 0, so
    // frameOverview cannot measure an aspect ratio and keeps the proven
    // fitBounds framing — this is also the mobile/minimal-fake path.
    const { map, factory } = makeCameraFake();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });

    mgr.frameOverview();

    expect(map.fitBounds).toHaveBeenCalledWith(
      OVERVIEW_BOUNDS,
      overviewFitOptions(),
    );
    expect(map.easeTo).not.toHaveBeenCalled();

    mgr.destroy();
  });

  it('on a WIDE desktop container with easeTo present → easeTo(center=OVERVIEW_DESKTOP_CENTER, zoom=OVERVIEW_DESKTOP_ZOOM)', () => {
    const { map, factory } = makeCameraFake();
    const mgr = new MapManager();
    // 1440x800 → aspect 1.8 (wide desktop) → centerZoom framing.
    mgr.init({
      container: sizedContainer(1440, 800),
      config: CONFIG,
      mapFactory: factory,
    });

    mgr.frameOverview();

    expect(map.easeTo).toHaveBeenCalledTimes(1);
    const [easeArg] = map.easeTo.mock.calls[0] as [
      { center: [number, number]; zoom: number; duration: number },
    ];
    // Product framing: the tuned reference center + product zoom so the NCR
    // reads large, close, and dominant.
    expect(easeArg.center).toEqual(OVERVIEW_DESKTOP_CENTER);
    expect(easeArg.zoom).toBe(OVERVIEW_DESKTOP_ZOOM);
    expect(easeArg.zoom).toBeGreaterThanOrEqual(STYLE_MIN_ZOOM);
    expect(easeArg.zoom).toBeLessThanOrEqual(STYLE_MAX_ZOOM);
    expect(easeArg.duration).toBeLessThanOrEqual(1000);
    // centerZoom path must NOT also call fitBounds.
    expect(map.fitBounds).not.toHaveBeenCalled();

    mgr.destroy();
  });

  it('on a WIDE desktop container WITHOUT easeTo → falls back to fitBounds without throwing', () => {
    // makeFake() has no easeTo; give it a wide, measurable container.
    const { map, factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({
      container: sizedContainer(1440, 800),
      config: CONFIG,
      mapFactory: factory,
    });

    expect(() => mgr.frameOverview()).not.toThrow();
    expect(map.fitBounds).toHaveBeenCalledWith(
      OVERVIEW_BOUNDS,
      overviewFitOptions(),
    );

    mgr.destroy();
  });
});

// --- 3D view (Mapbox Standard) ---------------------------------------------

describe('MapManager 3D view', () => {
  function initWith3DFake() {
    const { map, factory } = makeCameraFake();
    const styleMap = map as CameraFakeMap & {
      setConfigProperty: ReturnType<typeof vi.fn>;
      addSource: ReturnType<typeof vi.fn>;
      addLayer: ReturnType<typeof vi.fn>;
      getLayer: ReturnType<typeof vi.fn>;
    };
    styleMap.setConfigProperty = vi.fn();
    styleMap.addSource = vi.fn();
    styleMap.addLayer = vi.fn();
    styleMap.getLayer = vi.fn(() => undefined);
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });
    return { map: styleMap, mgr };
  }

  it('constructs with the Standard faded/day config and 3D hidden', () => {
    const { map, mgr } = initWith3DFake();
    expect(map.__options.config).toEqual({
      basemap: { ...BAHAROUTE_STANDARD_CONFIG },
    });
    // NCR-only: basemap settlement/POI/transit labels OFF so surrounding
    // places never appear; road labels stay for navigation context.
    const basemap = (map.__options.config as { basemap: Record<string, unknown> })
      .basemap;
    expect(basemap.showPlaceLabels).toBe(false);
    expect(basemap.showPointOfInterestLabels).toBe(false);
    expect(basemap.showTransitLabels).toBe(false);
    expect(basemap.showRoadLabels).toBe(true);
    expect(mgr.is3D()).toBe(false);
    mgr.destroy();
  });

  it('installs the NCR-only clip layer on load', () => {
    const { map, mgr } = initWith3DFake();
    map.emit('load');
    expect(map.addSource).toHaveBeenCalledWith(
      NCR_CLIP_SOURCE_ID,
      expect.objectContaining({ type: 'geojson' }),
    );
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: NCR_CLIP_LAYER_ID, type: 'clip', source: NCR_CLIP_SOURCE_ID }),
    );
    mgr.destroy();
  });

  it('set3D toggles Standard 3D objects and tilts / flattens the camera', () => {
    const { map, mgr } = initWith3DFake();

    mgr.set3D(true);
    expect(map.setConfigProperty).toHaveBeenLastCalledWith('basemap', 'show3dObjects', true);
    expect(map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ pitch: VIEW_3D_PITCH }),
    );
    expect(mgr.is3D()).toBe(true);

    mgr.set3D(false);
    expect(map.setConfigProperty).toHaveBeenLastCalledWith('basemap', 'show3dObjects', false);
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 0 }));
    expect(mgr.is3D()).toBe(false);
    mgr.destroy();
  });

  it('recenter keeps the 3D tilt while in 3D', () => {
    const { map, mgr } = initWith3DFake();
    mgr.recenter();
    expect(map.fitBounds).toHaveBeenLastCalledWith(METRO_MANILA_EXTENT, { duration: 800 });
    mgr.set3D(true);
    mgr.recenter();
    expect(map.fitBounds).toHaveBeenLastCalledWith(METRO_MANILA_EXTENT, {
      duration: 800,
      pitch: VIEW_3D_PITCH,
    });
    mgr.destroy();
  });

  it('set3D is a safe no-op on minimal fakes and before init', () => {
    expect(() => new MapManager().set3D(true)).not.toThrow();
    const { map, factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });
    expect(() => mgr.set3D(true)).not.toThrow();
    expect(() => map.emit('load')).not.toThrow();
    mgr.destroy();
  });
});

describe('MapManager drive view', () => {
  function initDriveFake() {
    const { map, factory } = makeCameraFake();
    const layers = new Set<string>();
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const m = map as CameraFakeMap & Record<string, ReturnType<typeof vi.fn>>;
    m.setConfigProperty = vi.fn();
    m.jumpTo = vi.fn();
    m.addSource = vi.fn((id: string) => sources.set(id, { setData: vi.fn() }));
    m.addLayer = vi.fn((l: { id: string }) => layers.add(l.id));
    m.getLayer = vi.fn((id: string) => (layers.has(id) ? {} : undefined));
    m.getSource = vi.fn((id: string) => sources.get(id));
    m.removeLayer = vi.fn((id: string) => layers.delete(id));
    m.removeSource = vi.fn((id: string) => sources.delete(id));
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });
    return { m, mgr, layers, sources };
  }
  const route: [number, number][] = [
    [120.99, 14.51],
    [120.99, 14.52],
  ];

  it('enters 3D with trees off, adds route/car/radius clip, and follows the car', () => {
    const { m, mgr, layers } = initDriveFake();
    mgr.startDriveView(route);
    expect(mgr.isDriving()).toBe(true);
    expect(m.setConfigProperty).toHaveBeenCalledWith('basemap', 'show3dObjects', true);
    expect(m.setConfigProperty).toHaveBeenCalledWith('basemap', 'show3dTrees', false);
    expect(layers).toEqual(
      new Set(['drive-route-line', 'drive-3d-radius-clip', 'drive-car-dot']),
    );

    mgr.updateDrive({ position: [120.99, 14.515], bearing: 0 });
    expect(m.jumpTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ center: [120.99, 14.515], zoom: DRIVE_ZOOM, pitch: DRIVE_PITCH }),
    );
    mgr.destroy();
  });

  it('moves the radius clip only after DRIVE_RADIUS_UPDATE_M', () => {
    const { mgr, sources } = initDriveFake();
    mgr.startDriveView(route);
    const radius = sources.get('drive-3d-radius-mask')!;
    mgr.updateDrive({ position: [120.99, 14.5105], bearing: 0 }); // ~55 m
    expect(radius.setData).not.toHaveBeenCalled();
    mgr.updateDrive({ position: [120.99, 14.5125], bearing: 0 }); // ~275 m
    expect(radius.setData).toHaveBeenCalledTimes(1);
    mgr.destroy();
  });

  it('keeps flood markers and labels at their original locations across reroutes', () => {
    const { m, mgr, layers, sources } = initDriveFake();
    const markers = [
      { position: [120.99, 14.516] as [number, number], color: '#cc0000', label: 'DEMO · Not passable' },
      { position: [120.99, 14.518] as [number, number], color: '#ffcc00', label: 'DEMO · Passable' },
    ];
    mgr.startDriveView(route, markers);
    const markerSource = sources.get('drive-markers')!;
    expect(m.addSource).toHaveBeenCalledWith('drive-markers', expect.objectContaining({
      data: expect.objectContaining({
        features: markers.map((marker) => expect.objectContaining({
          geometry: { type: 'Point', coordinates: marker.position },
          properties: { color: marker.color, label: marker.label },
        })),
      }),
    }));
    const alternative: [number, number][] = [[120.99, 14.515], [121, 14.52]];
    mgr.setDriveRoute(alternative);
    mgr.updateDrive({ position: alternative[0], bearing: 45 });
    mgr.setDriveRoute([[121, 14.517], [121, 14.52]]);
    expect(sources.get('drive-route')?.setData).toHaveBeenCalledTimes(2);
    expect(markerSource.setData).not.toHaveBeenCalled();
    expect(sources.get('drive-markers')).toBe(markerSource);
    expect(layers.has('drive-markers-dot')).toBe(true);
    expect(layers.has('drive-markers-label')).toBe(true);
    mgr.destroy();
  });

  it('endDriveView removes overlays and restores trees + 2D', () => {
    const { m, mgr, layers, sources } = initDriveFake();
    mgr.startDriveView(route);
    mgr.endDriveView();
    expect(mgr.isDriving()).toBe(false);
    expect(mgr.is3D()).toBe(false);
    expect(layers.size).toBe(0);
    expect(sources.size).toBe(0);
    expect(m.setConfigProperty).toHaveBeenCalledWith('basemap', 'show3dTrees', true);
    expect(m.setConfigProperty).toHaveBeenLastCalledWith('basemap', 'show3dObjects', false);
    mgr.destroy();
  });

  it('is a safe no-op on minimal fakes', () => {
    const { factory } = makeFake();
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });
    expect(() => {
      mgr.startDriveView(route);
      mgr.updateDrive({ position: route[1], bearing: 0 });
      mgr.endDriveView();
    }).not.toThrow();
    mgr.destroy();
  });
});

describe('MapManager drive camera + radius options', () => {
  it('uses the driver camera preset and redraws the clip when the radius changes', () => {
    const { map, factory } = makeCameraFake();
    const setData = vi.fn();
    const m = map as CameraFakeMap & Record<string, unknown>;
    m.jumpTo = vi.fn();
    m.setConfigProperty = vi.fn();
    m.addSource = vi.fn();
    m.addLayer = vi.fn();
    m.getSource = vi.fn(() => ({ setData }));
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });

    mgr.setDriveCamera('driver');
    mgr.startDriveView([
      [120.99, 14.51],
      [120.99, 14.52],
    ]);
    mgr.updateDrive({ position: [120.99, 14.51], bearing: 0 });
    expect(m.jumpTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        zoom: DRIVE_CAMERAS.driver.zoom,
        pitch: DRIVE_CAMERAS.driver.pitch,
      }),
    );

    setData.mockClear();
    mgr.setDriveRadius(250);
    expect(setData).toHaveBeenCalledTimes(1);
    mgr.destroy();
  });
});

describe('MapManager.setMapContext (NCR-only ↔ nearby presentation)', () => {
  function initContextFake() {
    const { map, factory } = makeCameraFake();
    const m = map as CameraFakeMap & Record<string, ReturnType<typeof vi.fn>>;
    m.setConfigProperty = vi.fn();
    m.addSource = vi.fn();
    m.addLayer = vi.fn();
    // The outside-NCR mask layer exists (so visibility toggles apply).
    m.getLayer = vi.fn(() => ({ id: NCR_OUTSIDE_MASK_LAYER_ID }));
    m.setLayoutProperty = vi.fn();
    m.setMaxBounds = vi.fn();
    const mgr = new MapManager();
    mgr.init({
      container: document.createElement('div'),
      config: CONFIG,
      mapFactory: factory,
    });
    return { map: m, mgr };
  }

  it('defaults to "nearby" (surrounding areas shown for orientation)', () => {
    const { mgr } = initContextFake();
    expect(mgr.getMapContext()).toBe('nearby');
    mgr.destroy();
  });

  it('nearby mode restores place labels, hides the mask, and widens maxBounds', () => {
    const { map, mgr } = initContextFake();
    mgr.setMapContext('nearby');

    expect(map.setConfigProperty).toHaveBeenCalledWith('basemap', 'showPlaceLabels', true);
    expect(map.setConfigProperty).toHaveBeenCalledWith(
      'basemap',
      'showPointOfInterestLabels',
      true,
    );
    expect(map.setConfigProperty).toHaveBeenCalledWith('basemap', 'showTransitLabels', true);
    expect(map.setLayoutProperty).toHaveBeenCalledWith(
      NCR_OUTSIDE_MASK_LAYER_ID,
      'visibility',
      'none',
    );
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(METRO_MANILA_NEARBY_MAX_BOUNDS);
    expect(mgr.getMapContext()).toBe('nearby');
    mgr.destroy();
  });

  it('ncr-only mode hides place labels, shows the mask, and tightens maxBounds', () => {
    const { map, mgr } = initContextFake();
    mgr.setMapContext('nearby');
    mgr.setMapContext('ncr-only');

    expect(map.setConfigProperty).toHaveBeenLastCalledWith(
      'basemap',
      'showTransitLabels',
      false,
    );
    expect(map.setLayoutProperty).toHaveBeenLastCalledWith(
      NCR_OUTSIDE_MASK_LAYER_ID,
      'visibility',
      'visible',
    );
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(METRO_MANILA_MAX_BOUNDS);
    expect(mgr.getMapContext()).toBe('ncr-only');
    mgr.destroy();
  });

  it('is a safe no-op before init', () => {
    const mgr = new MapManager();
    expect(() => mgr.setMapContext('nearby')).not.toThrow();
    expect(mgr.getMapContext()).toBe('nearby');
  });
});

describe('MapManager.onRoutePreviewSelect (map-line selection)', () => {
  it('resolves the clicked alternative route id to the select callback', () => {
    const { map, factory } = makeFake();
    // Override on/off to handle the LAYER-SCOPED form: on(type, layerId, handler).
    const layerListeners = new Map<string, (e: unknown) => void>();
    (map as unknown as { on: unknown }).on = (
      type: string,
      layer: string,
      handler: (e: unknown) => void,
    ) => layerListeners.set(`${type}:${layer}`, handler);
    (map as unknown as { off: unknown }).off = (type: string, layer: string) =>
      layerListeners.delete(`${type}:${layer}`);
    (map as unknown as { getCanvas: () => { style: { cursor: string } } }).getCanvas =
      () => ({ style: { cursor: '' } });
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });

    const onSelect = vi.fn();
    const teardown = mgr.onRoutePreviewSelect(onSelect);

    // Simulate a click on an alternative line carrying its routeId.
    const clickHandler = layerListeners.get('click:route-preview-alt-line');
    expect(clickHandler).toBeTypeOf('function');
    clickHandler!({
      features: [{ id: 'drive-route-alt1', properties: { routeId: 'drive-route-alt1' } }],
    });
    expect(onSelect).toHaveBeenCalledWith('drive-route-alt1');

    teardown();
    expect(layerListeners.has('click:route-preview-alt-line')).toBe(false);
    mgr.destroy();
  });

  it('is a safe no-op when the map lacks layer-scoped events', () => {
    const mgr = new MapManager();
    // Before init the map is null → returns a no-op teardown, never throws.
    const teardown = mgr.onRoutePreviewSelect(vi.fn());
    expect(() => teardown()).not.toThrow();
  });
});


describe('route preview visibility and selection', () => {
  it.each(['load', 'idle'])('draws the latest route selected before map readiness on %s', (event) => {
    const { map, factory } = makeFake();
    let loaded = false;
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, unknown>();
    Object.assign(map, {
      isStyleLoaded: () => loaded,
      addSource: (id: string) => {
        if (!loaded) throw new Error('Style is not done loading');
        sources.set(id, { setData: vi.fn() });
      },
      getSource: (id: string) => sources.get(id),
      removeSource: (id: string) => sources.delete(id),
      addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
      getLayer: (id: string) => layers.get(id),
      removeLayer: (id: string) => layers.delete(id),
    });
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });
    const routes = [
      { id: 'a', geometry: [[121, 14.6], [121.05, 14.62]] as [number, number][] },
      { id: 'b', geometry: [[121, 14.6], [121.02, 14.61], [121.05, 14.62]] as [number, number][] },
    ];
    mgr.showRoutePreview(routes, 'a', [[121, 14.6], [121.05, 14.62]]);
    mgr.updateRoutePreviewSelection(routes, 'b');
    expect(mgr.isRoutePreviewActive()).toBe(false);
    loaded = true;
    map.emit(event);
    expect(mgr.isRoutePreviewActive()).toBe(true);
    expect(sources.get('route-preview-selected')?.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection', features: [expect.objectContaining({
        properties: { routeId: 'b' }, geometry: { type: 'LineString', coordinates: routes[1].geometry },
      })],
    });
    // A production style reload discards custom sources; replay their geometry.
    sources.clear(); layers.clear();
    map.emit('style.load');
    expect(layers.has('route-preview-selected-line')).toBe(true);
    expect(sources.get('route-preview-selected')?.setData).toHaveBeenCalled();
    mgr.clearRoutePreview();
    map.emit('style.load'); map.emit('idle');
    expect(sources.has('route-preview-selected')).toBe(false);
    mgr.destroy();
  });

  it('draws the selected route above alternatives and switches its geometry', () => {
    const { map, factory } = makeFake();
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, unknown>();
    const addLayer = vi.fn((layer: { id: string }) => layers.set(layer.id, layer));
    Object.assign(map, {
      addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
      getSource: (id: string) => sources.get(id),
      removeSource: (id: string) => sources.delete(id),
      addLayer,
      getLayer: (id: string) => layers.get(id),
      removeLayer: (id: string) => layers.delete(id),
    });
    const mgr = new MapManager();
    mgr.init({ container: document.createElement('div'), config: CONFIG, mapFactory: factory });
    const routes = [
      { id: 'a', geometry: [[121, 14.6], [121.05, 14.62]] as [number, number][] },
      { id: 'b', geometry: [[121, 14.6], [121.02, 14.62], [121.05, 14.62]] as [number, number][],
        markers: [
          { position: [121.01, 14.61] as [number, number], color: '#ffff00', label: 'DEMO · Passable' },
          { position: [121.04, 14.62] as [number, number], color: '#ff0000', label: 'DEMO · Not passable' },
        ] },
    ];
    mgr.showRoutePreview(routes, 'a', [[121, 14.6], [121.05, 14.62]]);
    expect(layers.get('route-preview-selected-line')).toMatchObject({
      slot: 'top', paint: { 'line-color': '#1a56db', 'line-width': 8, 'line-opacity': 1 },
    });
    expect(layers.get('route-preview-selected-casing')).toMatchObject({
      source: 'route-preview-selected', paint: { 'line-color': '#ffffff', 'line-width': 12 },
    });
    mgr.updateRoutePreviewSelection(routes, 'b');
    expect(sources.get('route-preview-floods')?.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection', features: routes[1].markers!.map((marker) => expect.objectContaining({
        geometry: { type: 'Point', coordinates: marker.position },
        properties: { color: marker.color, label: marker.label },
      })),
    });
    expect(layers.has('route-preview-floods-label')).toBe(true);
    expect(sources.get('route-preview-selected')?.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection', features: [expect.objectContaining({
        properties: { routeId: 'b' }, geometry: { type: 'LineString', coordinates: routes[1].geometry },
      })],
    });
    expect(sources.get('route-preview-alt')?.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection', features: [expect.objectContaining({ properties: { routeId: 'a' } })],
    });
    mgr.updateRoutePreviewSelection(routes, '');
    expect(sources.get('route-preview-floods')?.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
    expect(sources.get('route-preview-selected')?.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection', features: [],
    });
    expect(sources.get('route-preview-alt')?.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection', features: expect.arrayContaining([
        expect.objectContaining({ properties: { routeId: 'a' } }),
        expect.objectContaining({ properties: { routeId: 'b' } }),
      ]),
    });
    mgr.clearRoutePreview();
    expect(layers.has('route-preview-selected-casing')).toBe(false);
    expect(sources.has('route-preview-selected')).toBe(false);
    expect(sources.has('route-preview-floods')).toBe(false);
    expect(layers.has('route-preview-floods-label')).toBe(false);
    mgr.destroy();
  });
});
