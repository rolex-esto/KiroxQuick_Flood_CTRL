import type { FloodReport } from '../types/flood';
import { collectRouteFloods, collectReportedFloods, floodHazardsOnRoute, type LocatedRouteFlood } from '../services/routeFloodHazards';
import { findFloodAvoidingReroutes, rankFloodAvoidingOffers, rebaseMovingReroute, avoidsFloodPoints } from '../services/floodAvoidingReroute';
// src/components/MapView.tsx
//
// React wrapper around MapManager (design â†’ Architecture: "React never touches
// the raw map object directly; MapView mounts a container div and delegates to
// MapManager"). On mount it creates a MapManager and calls init(); on unmount
// it calls destroy().
//
// Task 15.2 makes MapView the coherent whole:
//   - It renders the LoadingIndicator while tiles load and dismisses it on the
//     MapManager `onReady` (Req 1.5). On `onTileFailure` it shows the
//     ErrorMessage ("The map could not load") while keeping the app alive and
//     interactive (Req 1.6, 18.1).
//   - It renders the control cluster over the map: ZoomControls (wired to
//     MapManager.zoomIn/zoomOut), RecenterControl (â†’ MapManager.recenter),
//     LocationControl (â†’ MarkerManager origin marker + MapManager center), and
//     LayerControl (listing the DataSource layers, toggling via a
//     LayerRegistry.setVisibility over the real map).
//   - On ready, when a REAL map is present, it installs the flood
//     susceptibility layer (installFloodSusceptibility) via a LayerRegistry and
//     wires the susceptibility popup (installSusceptibilityPopup) to render a
//     FloodPopup. These real-integration paths are guarded so they only run
//     with a real map (getMap() returning a canvas-capable map) and never break
//     the injected fake-map tests (jsdom, no WebGL).
//   - It shows the DemoDataBadge whenever demo/fixture layers are present â€” in
//     Milestone 1 they always are (Req 15.2).
//
// Testability: the MapManager is created through an injectable `createMapManager`
// seam so a fake can be supplied in jsdom (no WebGL). The default builds a real
// MapManager; a `mapFactory` prop is forwarded to MapManager.init so the map
// constructor itself can also be faked without replacing the manager. The
// DataSource and MarkerManager factory are likewise injectable for tests.

import { FloodVoiceAgent, type FloodVoiceStatus } from '../services/floodVoiceAgent';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapManager,
  type MapContext,
  type MapFactory,
  type MinimalMap,
} from '../map/MapManager';
import type { AppConfig } from '../types/config';
import type { DataLayerMeta, DataSource, LayerId } from '../types/layer';
import { FixtureDataSource } from '../services/FixtureDataSource';
import { LoadingIndicator } from './overlays/LoadingIndicator';
import { ErrorMessage } from './overlays/ErrorMessage';
import { DemoDataBadge } from './overlays/DemoDataBadge';
import { CoverageBadge } from './overlays/CoverageBadge';
import { FloodPopup, type FloodPopupProps } from './overlays/FloodPopup';
import { ZoomControls } from './controls/ZoomControls';
import { RecenterControl } from './controls/RecenterControl';
import { ViewModeControl } from './controls/ViewModeControl';
import { MapContextControl } from './controls/MapContextControl';
import { MapModeSwitcher, type MapMode } from './controls/MapModeSwitcher';
import { RotateControl } from './controls/RotateControl';
import { DriveSimulator } from '../simulation/DriveSimulator';
import { SIM_SPEED_MPS, SIM_PLAYBACK_RATE, type SimPlaybackRate } from '../simulation/DriveSimulator';
import { PITX_TO_MOA_MANEUVERS, PITX_TO_MOA_ROUTE } from '../data/fixtures/pitxToMoaRoute';
import { type DriveHazard } from '../data/fixtures/driveHazards';
import { PITX_TO_MOA_REROUTES, type FloodReroute } from '../data/fixtures/floodReroutes';
import type { RouteManeuver } from '../data/fixtures/pitxToMoaRoute';
import {
  branchPoint,
  stitchReroute,
  type RerouteOffer,
} from '../simulation/reroute';
import type { DriveFrame } from '../simulation/DriveSimulator';
import { RerouteOffer as RerouteOfferCard } from './driving/RerouteOffer';
import {
  computeNavState,
  formatDistance,
  formatDuration,
  type NavState,
} from '../simulation/navigation';
import { measureRoute, pointAlong, type MeasuredRoute } from '../simulation/routeGeometry';
import {
  RouteSearchPanel,
  type TripEndpoint,
  type PickTarget,
  type LocationStatus,
} from './trip/RouteSearchPanel';
import { RouteComparePanel } from './trip/RouteComparePanel';
import { LocationConsentDialog } from './trip/LocationConsentDialog';
import {
  planRoutes,
  compareRoutes,
  getInitialRouteSelection,
  isRouteStartBlocked,
  type RouteOption,
  type RoutePreference,
} from '../services/routePlanning';
import type { TravelMode } from '../services/directions';
import { isWithinNCR, UNSUPPORTED_AREA_MESSAGE } from '../services/ncrPlaces';
import { currentRiskLabel, formatRelativeTime } from '../layers/riskLabels';
import { isDataQualityState } from '../types/risk';
import { FLOOD_STATE_COLORS, HISTORICAL_RISK_COLORS } from '../map/basemap/colorTokens';
import { DrivingHud } from './driving/DrivingHud';
import type { DriveCameraMode, DriveMarker, DriveRadius, DriveUpdate, PreviewRoute } from '../map/MapManager';

/** The original PITX â†’ MOA route, measured once (reroutes branch off it). */
const BASE_ROUTE = measureRoute(PITX_TO_MOA_ROUTE);

/** Marker coordinates and alerts share the selected route's measured geometry. */
function demoMarkersFor(candidate: RouteOption['candidate']): DriveMarker[] {
  const measured = measureRoute(candidate.route);
  return (candidate.demoFloods ?? []).map((hazard) => ({
    position: pointAlong(measured, hazard.atM),
    color: FLOOD_STATE_COLORS[hazard.state].hex,
    label: `DEMO · ${hazard.passability === 'passable' ? 'Passable' : 'Not passable'}`,
  }));
}
import { LocationControl } from './controls/LocationControl';
import { LayerControl } from './controls/LayerControl';
import { LayersButton } from './controls/LayersButton';
import { CamButton } from './controls/CamButton';
import { CloseIcon } from './controls/icons';
import { MapLegend } from './overlays/MapLegend';
import { MarkerManager, type MarkerManagerOptions } from './markers/markerManager';
import { mapboxMarkerFactory } from './markers/mapboxMarkerFactory';
import { CameraMarkerManager } from './markers/cameraMarkerManager';
import { mapboxCameraMarkerFactory } from './markers/mapboxCameraFactory';
import type { MetroManilaTrafficCamera } from '../types/camera';
import {
  clipCameraViewportToNcr,
  fetchWindyCameraImageUrl,
  fetchWindyCameras,
  type CameraViewportBounds,
  type WindyCameraSnapshot,
} from '../services/windyCameraService';
import { fetchCameraWeather } from '../services/cameraWeatherService';
import { isCameraCityVisible } from '../layers/cameraWebcamLayer';
import {
  requestLocation as defaultRequestLocation,
  type LocationResult,
} from '../services/geolocation';
import { LayerRegistry, type MapLayerAdapter } from '../layers/LayerRegistry';
import {
  installFloodSusceptibility,
  type SusceptibilityMapAdapter,
} from '../layers/floodSusceptibilityLayer';
import {
  installCityFloodSummary,
  type CitySummaryMapAdapter,
} from '../layers/cityFloodSummaryLayer';
import {
  installSusceptibilityPopup,
  type LngLatLike,
  type SusceptibilityPopupMap,
} from '../layers/susceptibilityPopup';
import {
  installCityFloodSummaryPopup,
  type CitySummaryPopupMap,
} from '../layers/cityFloodSummaryPopup';
import {
  installBarangayFloodRisk,
  setSelectedBarangay,
  barangayRiskFillOpacityExpression,
  BARANGAY_RISK_SOURCE_ID,
  BARANGAY_RISK_FILL_LAYER_ID,
  type BarangayRiskMapAdapter,
  type FeatureStateMap,
} from '../layers/barangayFloodRiskLayer';
import {
  installBarangayPopup,
  type BarangayPopupMap,
} from '../layers/barangayPopup';
import {
  installReportMarkers,
  installReportPopups,
  updateCommunityReportsSource,
  setCommunityReportsVisibility,
  reregisterCommunityImages,
  COMMUNITY_REPORTS_LAYER_ID,
  type PointLayerMapAdapter,
  type PointSourceUpdateMap,
  type ReportPopupMap,
  type ReportPopupData,
} from '../layers/reportMarkersLayer';
import {
  installCityContext,
  type CityContextMapAdapter,
} from '../layers/cityContextLayer';
import { ReportPopup, type ReportPopupProps } from './overlays/ReportPopup';
import { ReportForm } from './overlays/ReportForm';
import {
  buildCommunityReport,
  type ReportConditions,
} from '../services/reportLifecycle';
import type { CommunityReport } from '../types/report';
import { resolveBarangayForPoint } from '../services/reportResolution';
import { barangayInfoByPsgc } from '../data/geojson/ncrBarangays';
import {
  HistoricalEvidencePopup,
  type HistoricalEvidencePopupProps,
} from './overlays/HistoricalEvidencePopup';
import {
  installHistoricalEvidence,
  setHistoricalEvidenceVisibility,
  updateHistoricalEvidenceSource,
  reregisterHistoricalEvidenceImage,
  type HistoricalLayerMapAdapter,
  type HistoricalSourceUpdateMap,
} from '../layers/historicalEvidenceLayer';
import { installHistoricalEvidenceSelection } from '../layers/historicalEvidenceSelection';
import { HistoricalEvidencePanel } from './insights/HistoricalEvidencePanel';
import { historicalFloodEvidence } from '../data/historical/historicalFloodEvidence';
import {
  FloodInsights,
  type InsightsTab,
  type SheetState,
} from './insights/FloodInsights';
import { HistoricalExplorePanel } from './insights/HistoricalExplorePanel';
import { historicalRiskByBarangay } from '../data/historical/ncrHistoricalFloodRisk';
import {
  applyHistoricalRiskStates,
  applyHistoricalFilter,
  applyHistoricalCityScope,
  historicalFillOpacityExpression,
  setSelectedHistoricalBarangay,
  buildHistoricalSource,
  buildHistoricalFillLayer,
  buildHistoricalOutlineLayer,
  buildHistoricalSelectedLayer,
  buildHistoricalBarangayLabelLayer,
  buildHistoricalSelectedLabelLayer,
  buildBarangayLabelSource,
  cityLabelFilter,
  selectedLabelFilter,
  cityBounds,
  barangayBounds,
  DEFAULT_HISTORICAL_FILTER,
  HISTORICAL_RISK_SOURCE_ID,
  HISTORICAL_RISK_FILL_LAYER_ID,
  HISTORICAL_RISK_OUTLINE_LAYER_ID,
  HISTORICAL_SELECTED_LAYER_ID,
  HISTORICAL_LABEL_LAYER_ID,
  HISTORICAL_LABEL_SELECTED_LAYER_ID,
  HISTORICAL_LABEL_SOURCE_ID,
  type HistoricalFilterState,
  type HistoricalMapAdapter,
  type HistoricalFeatureStateMap,
} from '../layers/historicalFloodRisk';
import {
  buildCityBoundarySource,
  buildHistoricalCityFillLayer,
  CITY_HISTORICAL_FILL_LAYER_ID,
  buildCityBoundaryLayer,
  buildCityBoundarySelectedLayer,
  installCityHover,
  installCityClick,
  applyCityFocus,
  CITY_BOUNDARY_SOURCE_ID,
  CITY_BOUNDARY_LAYER_ID,
  CITY_BOUNDARY_SELECTED_LAYER_ID,
  type CityBoundaryMapAdapter,
  type CityBoundaryFeatureStateMap,
  type CityHoverInfo,
  type CityHoverMap,
  type CityClickMap,
} from '../layers/historicalCityBoundary';
import {
  installHistoricalHover,
  type HistoricalHoverInfo,
  type HistoricalHoverMap,
} from '../layers/historicalHover';
import {
  BarangayRiskController,
  type RiskControllerStatus,
} from '../services/barangayRiskController';
import { LiveStatusPill } from './overlays/LiveStatusPill';
import {
  resolvePrimaryLeftPanel,
  type PrimaryLeftPanel,
} from './primaryLeftPanel';
import type { TimelineStep } from '../types/risk';
import {
  communityReportFixtures,
  COMMUNITY_REPORTS_DEMO_SOURCE,
} from '../data/fixtures/communityReports';
import { loadOfficialConfirmations } from '../data/fixtures/officialConfirmations';

/** Dev-only Driver-Mode diagnostics: on in Vite dev, off in prod and tests. */
function driveDiagnosticsEnabled(): boolean {
  try {
    const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
    return Boolean(env?.DEV) && env?.MODE !== 'test';
  } catch {
    return false;
  }
}

/**
 * Logs the route-following state for one frame (throttled to ~1/sec of traveled
 * distance) so divergence between the interpolated position and the route line
 * is observable during development. Suppressed in production and under test.
 */
function logDriveFrame(
  route: MeasuredRoute,
  frame: DriveFrame,
): void {
  if (!driveDiagnosticsEnabled()) return;
  // Locate the current segment index for the traveled distance.
  const { cumulative } = route;
  let seg = 0;
  while (seg < cumulative.length - 1 && cumulative[seg + 1] < frame.traveledM) seg += 1;
  // eslint-disable-next-line no-console
  console.debug('[drive]', {
    coords: route.points.length,
    totalM: Math.round(route.length),
    traveledM: Math.round(frame.traveledM),
    segment: seg,
    lng: frame.position[0].toFixed(6),
    lat: frame.position[1].toFixed(6),
    bearing: Math.round(frame.bearing),
  });
}

/**
 * A thin, persistent Driver-Mode banner summarizing the CHOSEN route's flood
 * risk plus data freshness ("Route risk: Elevated Â· Updated 3 minutes ago").
 * It is intentionally minimal (not a modal) and uses a cached snapshot of the
 * route's aggregate risk captured at Start, so GPS movement does not re-query
 * the environment. Freshness comes from the shared risk-controller status.
 */
function DriveRiskBanner({
  option,
  status,
}: {
  option: RouteOption;
  status: RiskControllerStatus | null;
}) {
  const level = option.risk.level;
  const riskText =
    option.risk.dataUnavailable || isDataQualityState(level)
      ? 'Current information unavailable'
      : currentRiskLabel(level);
  const freshness =
    status && status.lastUpdated !== null
      ? `Updated ${formatRelativeTime(status.lastUpdated)}`
      : 'Live flood data unavailable';
  return (
    <div className="baharoute-drive-risk" role="status" data-testid="drive-risk-banner">
      <span className="baharoute-drive-risk__label">Route risk: {riskText}</span>
      <span className="baharoute-drive-risk__sep" aria-hidden="true">
        ·
      </span>
      <span className="baharoute-drive-risk__freshness">{freshness}</span>
    </div>
  );
}

/**
 * The minimal MapManager surface MapView depends on. A fake implementing this
 * can be injected via {@link MapViewProps.createMapManager} for tests.
 */
export interface MapManagerLike {
  init(options: {
    container: HTMLElement;
    config: AppConfig;
    onReady?: () => void;
    onTileFailure?: (reason: 'timeout' | 'error') => void;
    mapFactory?: MapFactory;
  }): unknown;
  destroy(): void;
  /** Optional imperative controls, present on the real MapManager. */
  zoomIn?: () => void;
  zoomOut?: () => void;
  recenter?: (durationMs?: number) => void;
  /** Switches the 2D/3D view (tilt + Standard 3D buildings). */
  set3D?: (on: boolean) => void;
  /** Switches the Map Context presentation (NCR-only â†” nearby areas). */
  setMapContext?: (context: MapContext) => void;
  /** Rotates the map by a signed degree delta (positive = clockwise). */
  rotateBy?: (deltaDeg: number, durationMs?: number) => void;
  /** Resets the map bearing to north (0). */
  resetNorth?: (durationMs?: number) => void;
  /** Reserves the next camera-intent token (stale-move guard). */
  nextCameraToken?: () => number;
  /** Smoothly focuses a chosen origin for a 3D preview (not Driver Mode). */
  focusOrigin?: (origin: [number, number], token?: number, bearing?: number) => void;
  /** Frames both trip points (origin + destination) with a mild 3D pitch. */
  framePoints?: (
    a: [number, number],
    b: [number, number],
    token?: number,
  ) => void;
  /** Draws the pre-drive route preview (selected emphasized + alternatives faded). */
  showRoutePreview?: (
    routes: ReadonlyArray<PreviewRoute>,
    selectedId: string,
    ends: [[number, number], [number, number]],
  ) => void;
  /** Re-emphasizes the preview for a newly selected route id. */
  updateRoutePreviewSelection?: (
    routes: ReadonlyArray<PreviewRoute>,
    selectedId: string,
  ) => void;
  /** Binds a click on alternative route lines â†’ route id; returns teardown. */
  onRoutePreviewSelect?: (onSelect: (routeId: string) => void) => () => void;
  /** Removes the route-preview overlays. */
  clearRoutePreview?: () => void;
  /** Current map bearing in degrees [0, 360). */
  getBearing?: () => number;
  /** Demo driver view (follow camera + 3D radius). */
  startDriveView?: (
    route: ReadonlyArray<[number, number]>,
    markers?: ReadonlyArray<DriveMarker>,
  ) => void;
  updateDrive?: (update: DriveUpdate) => void;
  setDriveCamera?: (mode: DriveCameraMode) => void;
  setDriveRoute?: (route: ReadonlyArray<[number, number]>) => void;
  setDriveRadius?: (radius: DriveRadius) => void;
  endDriveView?: () => void;
  /**
   * Frames the tuned NCR overview (Req 1.2). Called on ready so startup shows
   * Metro Manila centered and dominant. Optional so minimal fakes stay valid.
   */
  frameOverview?: () => void;
  /** Returns the underlying map instance, or null before init / after destroy. */
  getMap?: () => MinimalMap | null;
  /** Delegates to the underlying map's easeTo/flyTo. */
  easeTo?: (options: unknown) => void;
  flyTo?: (options: unknown) => void;
}

export interface MapViewProps {
  /** App config carrying the Tile_Provider API key (used to build the style). */
  config: AppConfig;
  /** Called once when the base map has loaded (Req 1.5). Defaults to a no-op. */
  onReady?: () => void;
  /** Called at most once when the base map fails to load (Req 1.6). Defaults to a no-op. */
  onTileFailure?: (reason: 'timeout' | 'error') => void;
  /**
   * Injectable factory for the MapManager. Defaults to constructing a real
   * MapManager. Tests supply a fake so mount/unmount can be exercised without
   * a real WebGL map.
   */
  createMapManager?: () => MapManagerLike;
  /**
   * Optional mapbox-gl map constructor override forwarded to
   * MapManager.init. Lets tests fake the map without replacing the manager.
   */
  mapFactory?: MapFactory;
  /**
   * The DataSource whose layers populate the LayerControl and drive the demo
   * badge. Defaults to the fixture-backed source (Milestone 1). Injectable for
   * tests.
   */
  dataSource?: DataSource;
  /**
   * Factory for the MarkerManager used to drop the current-location marker.
   * Defaults to a real Mapbox-backed manager. Injectable so tests can avoid
   * constructing real markers.
   */
  createMarkerManager?: (options: MarkerManagerOptions) => MarkerManager;
  /**
   * Startup current-location request (Req 2.1). Called ONCE after the map is
   * ready. On `granted` the Current_Location_Marker is placed WITHOUT moving
   * the camera; on denied/unavailable/timeout the Overview_State framing is
   * preserved (Req 2.2, 2.4, 21.1). Distinct from the user-initiated
   * LocationControl path (`handleLocated`), which MAY center on the user.
   * Defaults to the real `requestLocation`; injectable so tests can supply a
   * fake without a real browser Geolocation API.
   */
  requestLocation?: () => Promise<LocationResult>;
  /** Optional same-origin camera service override, primarily for integration tests. */
  loadCameraSnapshot?: (signal?: AbortSignal) => Promise<WindyCameraSnapshot>;
}

const noop = (): void => undefined;

/** Loading phase of the base map, driving which overlay (if any) is shown. */
type MapPhase = 'loading' | 'ready' | 'error';

/**
 * A map that also supports the layer/source/popup integration surface. The real
 * mapboxgl.Map satisfies this; a fake injected in tests generally does not,
 * which is how the integration paths stay guarded to real maps only.
 */
type IntegrableMap = MinimalMap &
  MapLayerAdapter &
  SusceptibilityMapAdapter &
  CitySummaryMapAdapter &
  SusceptibilityPopupMap &
  CitySummaryPopupMap;

/**
 * Best-effort check that a map object exposes the surface needed to install
 * layers/sources/popups. Fake maps used in jsdom tests lack these, so the
 * real-integration paths are skipped for them.
 */
function isIntegrableMap(map: MinimalMap | null | undefined): map is IntegrableMap {
  if (!map) return false;
  const m = map as Partial<IntegrableMap>;
  return (
    typeof m.addSource === 'function' &&
    typeof m.addLayer === 'function' &&
    typeof m.setLayoutProperty === 'function' &&
    typeof m.getLayer === 'function'
  );
}

/**
 * Sets a raw Mapbox layout `visibility` on a specific layer id, guarded so a
 * missing layer/map is a safe no-op. Used for companion layers (e.g. the
 * barangay-risk outline) that the LayerRegistry does not own.
 */
function setLayoutVisibility(
  map: unknown,
  layerId: string,
  visible: boolean,
): void {
  try {
    (map as { setLayoutProperty?: (l: string, k: string, v: unknown) => void })
      ?.setLayoutProperty?.(layerId, 'visibility', visible ? 'visible' : 'none');
  } catch {
    // Layer not present; ignore safely.
  }
}

/**
 * Sets a raw Mapbox PAINT property on a layer, guarded so a missing layer/map
 * is a safe no-op. Used only for visual co-existence when both flood layers are
 * on (dim the historical fill) â€” it never changes data or feature-state.
 */
function setPaint(map: unknown, layerId: string, name: string, value: unknown): void {
  try {
    (map as { setPaintProperty?: (l: string, k: string, v: unknown) => void })
      ?.setPaintProperty?.(layerId, name, value);
  } catch {
    // Layer not present; ignore safely.
  }
}

/**
 * Mounts a full-size container div for the map, manages the MapManager
 * lifecycle, renders loading/error/demo overlays, and renders the control
 * cluster over the map.
 */
export function MapView({
  config,
  onReady = noop,
  onTileFailure = noop,
  createMapManager,
  mapFactory,
  dataSource,
  createMarkerManager,
  requestLocation = defaultRequestLocation,
  loadCameraSnapshot,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const managerRef = useRef<MapManagerLike | null>(null);
  const markerManagerRef = useRef<MarkerManager | null>(null);
  const cameraMarkerManagerRef = useRef<CameraMarkerManager | null>(null);
  const cameraSnapshotRef = useRef<WindyCameraSnapshot | null>(null);
  const uninstallPopupRef = useRef<(() => void) | null>(null);
  const uninstallCityPopupRef = useRef<(() => void) | null>(null);
  const uninstallBarangayPopupRef = useRef<(() => void) | null>(null);
  const uninstallReportPopupRef = useRef<(() => void) | null>(null);
  /** Teardown for the community-marker image re-registration (style reload). */
  const uninstallMarkerImageReloadRef = useRef<(() => void) | null>(null);
  /** Teardown for the historical-evidence image re-registration (style reload). */
  const uninstallHistoricalImageReloadRef = useRef<(() => void) | null>(null);
  /** Owns the live barangay current-risk pipeline (rainfall â†’ risk â†’ paint). */
  const riskControllerRef = useRef<BarangayRiskController | null>(null);
  const unsubscribeRiskStatusRef = useRef<(() => void) | null>(null);
  /** Teardown for the community-report change listener (marker refresh). */
  const unsubscribeReportsRef = useRef<(() => void) | null>(null);
  /** Teardown for the barangay-source-ready reapply listener (sourcedata). */
  const uninstallRiskReapplyRef = useRef<(() => void) | null>(null);
  /** Teardown for the historical-source-ready reapply listener (sourcedata). */
  const uninstallHistoricalReapplyRef = useRef<(() => void) | null>(null);
  /** Teardown for the historical hover-tooltip listener. */
  const uninstallHistoricalHoverRef = useRef<(() => void) | null>(null);
  /** Teardown for the city hover-tooltip listener. */
  const uninstallCityHoverRef = useRef<(() => void) | null>(null);
  /** Teardown for the city map-click (select city) listener. */
  const uninstallCityClickRef = useRef<(() => void) | null>(null);
  /** Latest city-click handler, so the map click uses fresh state. */
  const cityClickHandlerRef = useRef<(cityPsgc: string) => void>(() => undefined);
  /** Teardown for the route-preview map-line click selection. */
  const uninstallRoutePreviewClickRef = useRef<(() => void) | null>(null);
  /** Latest route-select handler, so the map-line click uses fresh state. */
  const selectRouteHandlerRef = useRef<(id: string) => void>(() => undefined);
  /** Current Map Context, mirrored for the once-only ready handler. */
  const mapContextRef = useRef<MapContext>('nearby');
  /** Teardown for the map rotate-event listener that syncs the compass. */
  const uninstallRotateSyncRef = useRef<(() => void) | null>(null);
  /** Teardown for the "select on map" (trip pick) click listener. */
  const uninstallPickClickRef = useRef<(() => void) | null>(null);
  /**
   * Live visibility of the app-managed layers, read by the click handlers to
   * enforce interaction PRIORITY. When Current Flood Risk is visible, the
   * historical (susceptibility / city-summary) popup handlers defer so the
   * current-risk panel is what opens on a barangay click.
   */
  const layerVisibilityRef = useRef<Partial<Record<LayerId, boolean>>>({
    barangayFloodRisk: false,
    communityReports: false,
    officialClosures: false,
    floodSusceptibility: true,
  });

  const [phase, setPhase] = useState<MapPhase>('loading');
  const [failureReason, setFailureReason] = useState<'timeout' | 'error' | null>(null);
  /**
   * The currently open popup. Either a susceptibility/city FloodPopup or a
   * barangay current-risk info panel, tagged by `kind`.
   */
  const [popup, setPopup] = useState<
    | { kind: 'flood'; props: FloodPopupProps; lngLat: LngLatLike }
    | { kind: 'barangay'; psgc: string; lngLat?: LngLatLike }
    | { kind: 'report'; props: ReportPopupProps; lngLat: LngLatLike }
    | { kind: 'historical'; evidenceId: string; props: HistoricalEvidencePopupProps; lngLat?: LngLatLike }
    | null
  >(null);
  /** Live rainfall/risk status for the compact status pill. */
  const [riskStatus, setRiskStatus] = useState<RiskControllerStatus | null>(null);
  /** Selected short-term timeline step (NOW / +30 MIN / +1 HR). */
  const [timelineStep, setTimelineStep] = useState<TimelineStep>('now');
  /**
   * Which thematic layers are currently enabled. ALL default OFF on initial
   * load (only the Mapbox base map shows). This React state drives legend and
   * warning visibility; `layerVisibilityRef` mirrors it for the once-only mount
   * effect (click-priority) which cannot read state directly. Kept for the
   * browser session â€” toggling the layer drawer does not reset it.
   */
  const [layerVisible, setLayerVisible] = useState<Record<
    'barangayFloodRisk' | 'communityReports' | 'officialClosures' | 'floodSusceptibility',
    boolean
  >>({
    barangayFloodRisk: false,
    communityReports: false,
    officialClosures: false,
    floodSusceptibility: true,
  });
  const floodRiskVisible = layerVisible.barangayFloodRisk;
  const historicalVisible = layerVisible.floodSusceptibility;
  /**
   * The Historical Flood Risk filter (View by NCR/City/Barangay + city/barangay
   * selectors + risk-class filter). Independent of current-risk state; drives
   * the historical layer's per-barangay `histShown` feature-state.
   */
  const [historicalFilter, setHistoricalFilter] = useState<HistoricalFilterState>(
    DEFAULT_HISTORICAL_FILTER,
  );
  /** Latest historical filter, for the once-bound source-ready reapply. */
  const historicalFilterRef = useRef(historicalFilter);
  historicalFilterRef.current = historicalFilter;
  /**
   * Active tab of the unified Flood Insights panel. Remembered across barangay
   * selections so a user who prefers "Historical" keeps it; a barangay click
   * only overrides it when exactly one flood layer is enabled (see below).
   */
  const [insightsTab, setInsightsTab] = useState<InsightsTab>('current');
  /** Mobile bottom-sheet height state for Flood Insights. */
  const [insightsSheet, setInsightsSheet] = useState<SheetState>('half');
  /** Hovered historical barangay (name/city/class + cursor point), or null. */
  const [historicalHover, setHistoricalHover] = useState<HistoricalHoverInfo | null>(null);
  /** Hovered city boundary (name/count + cursor point), or null. */
  const [cityHover, setCityHover] = useState<CityHoverInfo | null>(null);
  const hoverDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepHistoricalHover = (): void => {
    if (hoverDismissRef.current) clearTimeout(hoverDismissRef.current);
  };
  const dismissHistoricalHover = (): void => {
    keepHistoricalHover();
    hoverDismissRef.current = setTimeout(() => {
      setHistoricalHover(null);
      setCityHover(null);
    }, 250);
  };
  useEffect(() => () => {
    if (hoverDismissRef.current) clearTimeout(hoverDismissRef.current);
  }, []);
  const evidenceSelectRef = useRef<(id: string) => void>(() => {});
  /**
   * Bumps whenever the risk controller repaints (poll tick / report added), so
   * an open barangay panel re-derives its props from the latest live data.
   */
  const [riskRevision, setRiskRevision] = useState(0);
  /**
   * Map Context presentation mode. Defaults to "nearby" (surrounding areas
   * shown for orientation); thematic data stays NCR-only regardless. Preserved
   * for the browser session; switching it never resets flood-layer selections
   * and never touches rainfall/risk state â€” it only re-styles the basemap
   * presentation.
   */
  const [mapContext, setMapContext] = useState<MapContext>('nearby');

  // The DataSource is stable for the component lifetime; default to fixtures.
  const source = useMemo<DataSource>(() => dataSource ?? new FixtureDataSource(), [dataSource]);
  const sourceLayers = useMemo<DataLayerMeta[]>(() => source.listLayers(), [source]);
  const hasDemoLayers = useMemo(() => sourceLayers.some((layer) => layer.isDemo), [sourceLayers]);

  /**
   * The curated LayerControl entries for this feature: the primary Current
   * Barangay Flood Risk layer (default on), the Baseline Flood Susceptibility
   * reference (default off), Community Reports and Confirmed Closures overlays
   * (default off). These map to app-managed canvas layers toggled via the
   * LayerRegistry in {@link handleLayerToggle}.
   */
  const currentLayerMetas = useMemo<DataLayerMeta[]>(
    () => [
      {
        id: 'barangayFloodRisk',
        label: 'Flood Risk',
        // Longer descriptive name for assistive tech.
        ariaLabel: 'Current barangay flood risk',
        isDemo: true,
        defaultVisible: false,
      },
      {
        id: 'communityReports',
        label: 'Community Reports',
        ariaLabel: 'Community flood reports (unconfirmed)',
        isDemo: true,
        defaultVisible: false,
      },
      {
        id: 'officialClosures',
        label: 'Confirmed Closures',
        ariaLabel: 'Confirmed road or area closures',
        isDemo: true,
        defaultVisible: false,
      },
    ],
    [],
  );
  const referenceLayerMetas = useMemo<DataLayerMeta[]>(
    () => [
      {
        id: 'floodSusceptibility',
        label: 'Historical Flood Risk',
        ariaLabel: 'Historical flood susceptibility (reference)',
        isDemo: true,
        defaultVisible: false,
      },
    ],
    [],
  );
  /** Flat list (for empty-state checks) + grouped presentation (Current/Reference). */
  const layers = useMemo<DataLayerMeta[]>(
    () => [...currentLayerMetas, ...referenceLayerMetas],
    [currentLayerMetas, referenceLayerMetas],
  );
  const layerGroups = useMemo(
    () => [
      { title: 'Current', layers: currentLayerMetas },
      { title: 'Reference', layers: referenceLayerMetas },
    ],
    [currentLayerMetas, referenceLayerMetas],
  );

  // Registry over the real map, created on ready so LayerControl toggles hit it.
  const registryRef = useRef<LayerRegistry | null>(null);

  // Keep the latest callbacks in refs so the mount effect stays stable (runs
  // once) without going stale on callback identity changes.
  const onReadyRef = useRef(onReady);
  const onTileFailureRef = useRef(onTileFailure);
  onReadyRef.current = onReady;
  onTileFailureRef.current = onTileFailure;


  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const manager = createMapManager ? createMapManager() : new MapManager();
    managerRef.current = manager;

    manager.init({
      container,
      config,
      onReady: () => {
        setPhase('ready');
        // Explicitly frame the tuned NCR overview now that the base map is
        // ready (Req 1.1). This is the single OVERVIEW-framing camera move at
        // startup; the granted-location path below must NOT move the camera.
        manager.frameOverview?.();
        onReadyRef.current();
        wireRealMapIntegration(manager);
        // Apply the current Map Context presentation (default NCR-only) once the
        // basemap + mask are ready, so a mode chosen before ready is honored.
        manager.setMapContext?.(mapContextRef.current);
        // PRIVACY-FIRST: BahaRoute does NOT request the device location on load.
        // The user's location is "Not shared" until they explicitly consent via
        // the "Use current location" flow. No navigator.geolocation call, no
        // browser permission prompt, no origin inferred, no camera move here.
      },
      onTileFailure: (reason) => {
        setPhase('error');
        setFailureReason(reason);
        onTileFailureRef.current(reason);
      },
      mapFactory,
    });

    return () => {
      if (uninstallPopupRef.current) {
        uninstallPopupRef.current();
        uninstallPopupRef.current = null;
      }
      if (uninstallCityPopupRef.current) {
        uninstallCityPopupRef.current();
        uninstallCityPopupRef.current = null;
      }
      if (uninstallBarangayPopupRef.current) {
        uninstallBarangayPopupRef.current();
        uninstallBarangayPopupRef.current = null;
      }
      if (uninstallReportPopupRef.current) {
        uninstallReportPopupRef.current();
        uninstallReportPopupRef.current = null;
      }
      if (uninstallMarkerImageReloadRef.current) {
        uninstallMarkerImageReloadRef.current();
        uninstallMarkerImageReloadRef.current = null;
      }
      if (uninstallHistoricalImageReloadRef.current) {
        uninstallHistoricalImageReloadRef.current();
        uninstallHistoricalImageReloadRef.current = null;
      }
      if (uninstallRotateSyncRef.current) {
        uninstallRotateSyncRef.current();
        uninstallRotateSyncRef.current = null;
      }
      if (uninstallPickClickRef.current) {
        uninstallPickClickRef.current();
        uninstallPickClickRef.current = null;
      }
      if (unsubscribeRiskStatusRef.current) {
        unsubscribeRiskStatusRef.current();
        unsubscribeRiskStatusRef.current = null;
      }
      if (unsubscribeReportsRef.current) {
        unsubscribeReportsRef.current();
        unsubscribeReportsRef.current = null;
      }
      if (uninstallRiskReapplyRef.current) {
        uninstallRiskReapplyRef.current();
        uninstallRiskReapplyRef.current = null;
      }
      if (uninstallHistoricalReapplyRef.current) {
        uninstallHistoricalReapplyRef.current();
        uninstallHistoricalReapplyRef.current = null;
      }
      if (uninstallHistoricalHoverRef.current) {
        uninstallHistoricalHoverRef.current();
        uninstallHistoricalHoverRef.current = null;
      }
      if (uninstallCityHoverRef.current) {
        uninstallCityHoverRef.current();
        uninstallCityHoverRef.current = null;
      }
      if (uninstallCityClickRef.current) {
        uninstallCityClickRef.current();
        uninstallCityClickRef.current = null;
      }
      if (uninstallRoutePreviewClickRef.current) {
        uninstallRoutePreviewClickRef.current();
        uninstallRoutePreviewClickRef.current = null;
      }
      if (riskControllerRef.current) {
        riskControllerRef.current.stop();
        riskControllerRef.current = null;
      }

      markerManagerRef.current?.destroy();
      markerManagerRef.current = null;
      cameraMarkerManagerRef.current?.destroy();
      cameraMarkerManagerRef.current = null;
      registryRef.current = null;
      manager.destroy();
      managerRef.current = null;
    };
    // The map is created once for the lifetime of the mounted component; config
    // and the injected seams are treated as fixed for that lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live camera data is an independent overlay. Query only the visible NCR
  // viewport on map movement; open image popups renew URLs by webcam ID.
  useEffect(() => {
    if (phase !== 'ready') return;
    const map = managerRef.current?.getMap?.() ?? null;
    if (!isIntegrableMap(map)) return;

    const markerManager = new CameraMarkerManager({
      map,
      factory: mapboxCameraMarkerFactory,
      refreshImageUrl: (webcamId, signal) => fetchWindyCameraImageUrl(webcamId, fetch, signal),
      loadWeather: (coordinates, signal) => fetchCameraWeather(coordinates, fetch, signal),
      canOpenPopup: (camera) => {
        const minimalMap = map as unknown as {
          getZoom?: () => number;
          getCenter?: () => { lng: number; lat: number } | [number, number];
          getBounds?: () => { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
        };
        const zoom = minimalMap.getZoom?.() ?? 12;
        const rawCenter = minimalMap.getCenter?.();
        const center: [number, number] | undefined = Array.isArray(rawCenter)
          ? rawCenter
          : rawCenter
            ? [rawCenter.lng, rawCenter.lat]
            : undefined;
        const rawBounds = minimalMap.getBounds?.();
        const bounds: [number, number, number, number] | undefined = rawBounds
          ? [rawBounds.getWest(), rawBounds.getSouth(), rawBounds.getEast(), rawBounds.getNorth()]
          : undefined;

        return isCameraCityVisible(camera, { zoom, center, bounds });
      },
    });
    cameraMarkerManagerRef.current = markerManager;

    const mapWithBounds = map as IntegrableMap & {
      getBounds?: () => { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
    };
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let requestController: AbortController | null = null;
    let requestSequence = 0;
    let lastViewportKey = '';
    let disposed = false;

    const currentViewport = (): CameraViewportBounds | null => {
      const bounds = mapWithBounds.getBounds?.();
      if (!bounds) return clipCameraViewportToNcr({ west: 120.9, south: 14.34, east: 121.15, north: 14.8 });
      return clipCameraViewportToNcr({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
    };

    const loadViewport = async (forceFresh = false): Promise<void> => {
      const bounds = currentViewport();
      if (!bounds) {
        lastViewportKey = 'outside-ncr';
        requestSequence += 1;
        requestController?.abort();
        requestController = null;
        cameraSnapshotRef.current = null;
        markerManager.setCameras([]);
        return;
      }

      const key = [bounds.west, bounds.south, bounds.east, bounds.north]
        .map((value) => value.toFixed(5)).join(',');
      if (!forceFresh && key === lastViewportKey) return;
      lastViewportKey = key;
      const camerasAlreadyInViewport = cameraSnapshotRef.current?.cameras.filter((camera) => {
        const [longitude, latitude] = camera.coordinates;
        return longitude >= bounds.west && longitude <= bounds.east &&
          latitude >= bounds.south && latitude <= bounds.north;
      }) ?? [];
      markerManager.setCameras(camerasAlreadyInViewport);
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      const sequence = ++requestSequence;

      try {
        const snapshot = loadCameraSnapshot
          ? await loadCameraSnapshot(controller.signal)
          : await fetchWindyCameras(fetch, controller.signal, bounds, forceFresh);
        if (disposed || sequence !== requestSequence) return;
        cameraSnapshotRef.current = snapshot;
        markerManager.setCameras(snapshot.cameras);
      } catch (error) {
        if (disposed || sequence !== requestSequence || (error instanceof DOMException && error.name === 'AbortError')) return;
        if (lastViewportKey === key) lastViewportKey = '';
        // Keep already-visible cameras available during a transient failure.
      } finally {
        if (requestController === controller) requestController = null;
      }
    };

    const scheduleViewportLoad = (): void => {
      const bounds = currentViewport();
      const observedKey = bounds
        ? [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(5)).join(',')
        : 'outside-ncr';
      if (observedKey !== lastViewportKey) {
        requestSequence += 1;
        requestController?.abort();
        requestController = null;
      }
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void loadViewport();
      }, 180);
    };

    map.on('moveend', scheduleViewportLoad);
    map.on('zoomend', scheduleViewportLoad);
    void loadViewport(true);

    return () => {
      disposed = true;
      requestSequence += 1;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      requestController?.abort();
      map.off('moveend', scheduleViewportLoad);
      map.off('zoomend', scheduleViewportLoad);
      markerManager.destroy();
      cameraMarkerManagerRef.current = null;
    };
  }, [phase, loadCameraSnapshot]);

  /**
   * On ready, when a REAL (integrable) map is present, install the flood
   * susceptibility layer through a LayerRegistry and wire the click/tap popup.
   * Guarded so it is a no-op for the injected fake maps used in jsdom tests, and
   * wrapped in try/catch so a failure here never crashes the app (Req 18.1).
   */
  function wireRealMapIntegration(manager: MapManagerLike): void {
    const map = manager.getMap?.() ?? null;
    if (!isIntegrableMap(map)) {
      // Fake map (tests) or no map: skip real integration, stay interactive.
      return;
    }

    // Keep the compass in sync with rotation done via gestures OR the control.
    try {
      const onRotate = (): void => setBearing(manager.getBearing?.() ?? 0);
      const rotatingMap = map as unknown as {
        on?: (t: string, l: () => void) => void;
        off?: (t: string, l: () => void) => void;
      };
      rotatingMap.on?.('rotate', onRotate);
      uninstallRotateSyncRef.current = () => rotatingMap.off?.('rotate', onRotate);
    } catch {
      // Rotation sync is best-effort; the control still works imperatively.
    }

    // "Select on map" for the trip flow: while a pick is active, the next map
    // click resolves an origin/destination. NCR-gated; out-of-NCR taps surface
    // the unsupported-area message and do NOT set the endpoint.
    try {
      const clickMap = map as unknown as {
        on?: (t: string, l: (e: { lngLat?: { lng: number; lat: number } }) => void) => void;
        off?: (t: string, l: (e: { lngLat?: { lng: number; lat: number } }) => void) => void;
      };
      const onClick = (e: { lngLat?: { lng: number; lat: number } }): void => {
        if (!e.lngLat) return;
        // Report-flooding pick takes priority when active: the next NCR tap
        // drops an unconfirmed community report at that point.
        if (reportPickActiveRef.current) {
          handleReportMapPick(e.lngLat.lng, e.lngLat.lat);
          return;
        }
        const target = pickTargetRef.current;
        if (!target) return;
        handleMapPick(target, e.lngLat.lng, e.lngLat.lat);
      };
      clickMap.on?.('click', onClick);
      uninstallPickClickRef.current = () => clickMap.off?.('click', onClick);
    } catch {
      // Best-effort; search + current location still set endpoints.
    }

    try {
      const registry = new LayerRegistry(map);
      registryRef.current = registry;
      // Fire-and-forget: the async installs load fixtures and add layers; a
      // rejection is caught so it never surfaces as an unhandled error.
      //
      // The per-city MODELED susceptibility SUMMARY is the LOWEST app layer
      // (just above the basemap). It reproduces the NCR overview composition and
      // is rendered BELOW the hazard-shaped susceptibility polygons and all
      // reports/routes; the LayerRegistry enforces that z-order regardless of
      // install order. It renders by default so flood awareness is visible in
      // OVERVIEW (Req 5). This is a modeled/historical summary, not current
      // flooding â€” labeling + popup make that explicit.
      // These installs are ASYNC (they load fixtures then add layers). Their
      // layers are added visible by default, so we must hide them AFTER the
      // install resolves â€” hiding synchronously here would run before the
      // layers exist and leave "Historical Flood Risk" showing on load. All
      // thematic layers start OFF; the user opts in via the layer drawer.
      // Their companion outlines are added directly (not registry-managed), so
      // hide those too or the demo city/hazard shapes linger over the map.
      void installCityFloodSummary(map, registry)
        .then(() => {
          registry.setVisibility('cityFloodSummary', false);
          setLayoutVisibility(map, 'cityFloodSummary-outline', false);
        })
        .catch(() => undefined);
      void installFloodSusceptibility(map, registry)
        .then(() => {
          registry.setVisibility('floodSusceptibility', false);
          setLayoutVisibility(map, 'floodSusceptibility-outline', false);
        })
        .catch(() => undefined);

      // HISTORICAL Flood Risk (derived Project NOAH / Phil-LiDAR per-barangay
      // susceptibility). Its own source + fill + outline, painted STATICALLY
      // via feature-state (no live API). Installed hidden; the "Historical
      // Flood Risk" layer toggle reveals it. Kept fully INDEPENDENT of the
      // current-risk layer/state.
      try {
        // Install in a deliberate BOTTOMâ†’TOP order so the polygon hierarchy
        // holds (spec #8): city base boundary â†’ barangay fill â†’ barangay
        // outline â†’ selected-city boundary â†’ selected-barangay outline.
        const cityAdapter = map as unknown as CityBoundaryMapAdapter;
        cityAdapter.addSource(CITY_BOUNDARY_SOURCE_ID, buildCityBoundarySource());
        cityAdapter.addLayer(buildHistoricalCityFillLayer());
        cityAdapter.addLayer(buildCityBoundaryLayer(CITY_BOUNDARY_SOURCE_ID));

        const brgyAdapter = map as unknown as HistoricalMapAdapter;
        brgyAdapter.addSource(HISTORICAL_RISK_SOURCE_ID, buildHistoricalSource());
        brgyAdapter.addLayer(buildHistoricalFillLayer(HISTORICAL_RISK_SOURCE_ID));
        brgyAdapter.addLayer(buildHistoricalOutlineLayer(HISTORICAL_RISK_SOURCE_ID));
        applyHistoricalCityScope(map, historicalFilterRef.current);

        // Selected-city boundary above barangay fills, below selected barangay.
        cityAdapter.addLayer(buildCityBoundarySelectedLayer(CITY_BOUNDARY_SOURCE_ID));
        // Selected-barangay outline on top of everything.
        brgyAdapter.addLayer(buildHistoricalSelectedLayer(HISTORICAL_RISK_SOURCE_ID));
        // Dedicated barangay LABEL point source (official name + derived class
        // as display props) feeding two symbol layers: zoom-aware city-scoped
        // labels + an always-visible selected-barangay label. Pure projection
        // of existing data; the polygon fill stays the primary risk viz.
        brgyAdapter.addSource(HISTORICAL_LABEL_SOURCE_ID, buildBarangayLabelSource());
        // Zoom-aware barangay NAME+CLASS labels (scoped to the selected city via
        // setFilter below; starts matching nothing so NCR overview stays clean).
        brgyAdapter.addLayer(buildHistoricalBarangayLabelLayer(HISTORICAL_LABEL_SOURCE_ID));
        // Always-visible selected-barangay label (scoped to the selected psgc).
        brgyAdapter.addLayer(buildHistoricalSelectedLabelLayer(HISTORICAL_LABEL_SOURCE_ID));

        applyHistoricalRiskStates(map as unknown as HistoricalFeatureStateMap);
        applyHistoricalFilter(
          map as unknown as HistoricalFeatureStateMap,
          DEFAULT_HISTORICAL_FILTER,
        );
        applyCityFocus(map as unknown as CityBoundaryFeatureStateMap, null);

        // Same dropped-feature-state race as the current-risk layer: the
        // emphasis/city-focus states written above can be lost if the sources
        // had not parsed yet. Re-apply the LATEST filter once either historical
        // source reports loaded. (The class color itself is a baked property,
        // so it never depends on this.)
        {
          const evented = map as unknown as {
            on?: (t: string, l: (e?: unknown) => void) => void;
            off?: (t: string, l: (e?: unknown) => void) => void;
          };
          const histSourcesReady = new Set<string>();
          const onHistSourceData = (e?: unknown): void => {
            const ev = e as { sourceId?: string; isSourceLoaded?: boolean } | undefined;
            if (
              ev?.sourceId !== HISTORICAL_RISK_SOURCE_ID &&
              ev?.sourceId !== CITY_BOUNDARY_SOURCE_ID
            ) {
              return;
            }
            if (ev.isSourceLoaded === false || histSourcesReady.has(ev.sourceId)) return;
            // Once loaded, feature-state persists; later filter changes are
            // applied by the filter effect, so reapply only on first load.
            histSourcesReady.add(ev.sourceId);
            const f = historicalFilterRef.current;
            applyHistoricalFilter(map as unknown as HistoricalFeatureStateMap, f);
            applyCityFocus(
              map as unknown as CityBoundaryFeatureStateMap,
              f.view === 'ncr' ? null : f.cityPsgc,
            );
          };
          evented.on?.('sourcedata', onHistSourceData);
          uninstallHistoricalReapplyRef.current = () =>
            evented.off?.('sourcedata', onHistSourceData);
        }

        for (const id of [
          CITY_HISTORICAL_FILL_LAYER_ID,
          CITY_BOUNDARY_LAYER_ID,
          CITY_BOUNDARY_SELECTED_LAYER_ID,
          HISTORICAL_RISK_FILL_LAYER_ID,
          HISTORICAL_RISK_OUTLINE_LAYER_ID,
          HISTORICAL_SELECTED_LAYER_ID,
          HISTORICAL_LABEL_LAYER_ID,
          HISTORICAL_LABEL_SELECTED_LAYER_ID,
        ]) {
          const filter = historicalFilterRef.current;
          const overview = filter.view === 'ncr' || !filter.cityPsgc;
          const enabled = layerVisibilityRef.current.floodSusceptibility === true;
          const surfaceVisible = id === CITY_HISTORICAL_FILL_LAYER_ID
            ? overview
            : id === HISTORICAL_RISK_FILL_LAYER_ID || id === HISTORICAL_RISK_OUTLINE_LAYER_ID
              ? !overview
              : true;
          setLayoutVisibility(map, id, enabled && surfaceVisible);
        }

        // Barangay hover tooltip (name / city / historical class).
        uninstallHistoricalHoverRef.current = installHistoricalHover(
          map as unknown as HistoricalHoverMap,
          (info) => {
            if (info) { keepHistoricalHover(); setHistoricalHover((previous) => previous?.psgc === info.psgc ? previous : info); setCityHover(null); }
            else dismissHistoricalHover();
          },
        );
        // City hover tooltip (city name + barangay count), city mode only.
        uninstallCityHoverRef.current = installCityHover(
          map as unknown as CityHoverMap,
          (info) => {
            if (info) { keepHistoricalHover(); setCityHover((previous) => previous?.cityPsgc === info.cityPsgc ? previous : info); setHistoricalHover(null); }
            else dismissHistoricalHover();
          },
        );
        // City map-line/polygon click â†’ select that city (city mode).
        uninstallCityClickRef.current = installCityClick(
          map as unknown as CityClickMap,
          (cityPsgc) => cityClickHandlerRef.current(cityPsgc),
        );
      } catch {
        // Historical layer is best-effort; its absence never breaks the map.
      }

      // Historical popups DEFER to the current-risk panel: they only open when
      // Current Flood Risk is not the active context (its layer is hidden). This
      // enforces the interaction priority regardless of Mapbox handler order â€”
      // the current-risk handler always wins while its layer is visible.
      const historicalIsActiveContext = (): boolean =>
        layerVisibilityRef.current.barangayFloodRisk !== true;

      uninstallPopupRef.current = installSusceptibilityPopup(
        map as SusceptibilityPopupMap,
        (props, lngLat) => {
          if (!historicalIsActiveContext()) return;
          setPopup({ kind: 'flood', props, lngLat });
        },
      );
      uninstallCityPopupRef.current = installCityFloodSummaryPopup(
        map as CitySummaryPopupMap,
        (props, lngLat) => {
          if (!historicalIsActiveContext()) return;
          setPopup({ kind: 'flood', props, lngLat });
        },
      );

      // PRIMARY current-conditions layer: barangay-level current flood risk.
      // The polygon source is installed once; the live rainfall poll repaints
      // it via feature-state through the BarangayRiskController. Wrapped in its
      // own try so a failure here never breaks the baseline layers above.
      try {
        installBarangayFloodRisk(map as unknown as BarangayRiskMapAdapter, registry);
        // ALL thematic layers start hidden on initial load â€” only the base map
        // shows until the user enables a layer. The barangay-risk fill + its
        // outline start off too (the current-risk fill is added visible by the
        // registry, so hide it explicitly here).
        registry.setVisibility('barangayFloodRisk', false);
        setLayoutVisibility(map, 'barangayFloodRisk-outline', false);
        // Historical (floodSusceptibility) + cityFloodSummary are hidden in the
        // async install .then handlers above (they add their layers later).

        const controller = new BarangayRiskController({
          reports: [...communityReportFixtures],
          officials: [...loadOfficialConfirmations()],
        });
        riskControllerRef.current = controller;
        controller.attachMap(map as unknown as FeatureStateMap);
        // When a report is submitted at runtime, refresh the community-reports
        // marker source so the new (unconfirmed) point appears immediately. The
        // controller already recomputed risk + the panel count; this only
        // updates the marker geometry. Teardown clears the single listener.
        unsubscribeReportsRef.current = controller.onReportsChanged((reports) => {
          const liveMap = managerRef.current?.getMap?.() ?? null;
          if (!liveMap) return;
          updateCommunityReportsSource(
            liveMap as unknown as PointSourceUpdateMap,
            reports,
          );
        });
        unsubscribeRiskStatusRef.current = controller.onStatus((status) => {
          setRiskStatus(status);
          // Nudge any open barangay panel to re-derive from the latest data.
          setRiskRevision((r) => r + 1);
        });
        controller.start();

        // FIX (current-risk race): feature-state written before the barangay
        // GeoJSON source has parsed its features is SILENTLY DROPPED by Mapbox,
        // so the controller's early paints (on attach + first poll) can be lost
        // and the fill renders the invisible UNKNOWN fallback â€” the "Live â€”
        // updated Just now but no colors" symptom. Re-apply the latest risk
        // snapshot whenever the barangay source (re)loads and once the map goes
        // idle, so the states land as soon as the features exist. Cheap and
        // idempotent (feature-state is keyed by PSGC; applying all is fine).
        try {
          const evented = map as unknown as {
            on?: (t: string, l: (e?: unknown) => void) => void;
            off?: (t: string, l: (e?: unknown) => void) => void;
            isSourceLoaded?: (id: string) => boolean;
          };
          const onSourceData = (e?: unknown): void => {
            const ev = e as { sourceId?: string; isSourceLoaded?: boolean } | undefined;
            if (ev?.sourceId && ev.sourceId !== BARANGAY_RISK_SOURCE_ID) return;
            // Only reapply once the source's tiles are actually loaded.
            const loaded =
              ev?.isSourceLoaded ??
              evented.isSourceLoaded?.(BARANGAY_RISK_SOURCE_ID) ??
              true;
            if (loaded) riskControllerRef.current?.repaint();
          };
          const onIdle = (): void => riskControllerRef.current?.repaint();
          evented.on?.('sourcedata', onSourceData);
          evented.on?.('idle', onIdle);
          uninstallRiskReapplyRef.current = () => {
            evented.off?.('sourcedata', onSourceData);
            evented.off?.('idle', onIdle);
          };
        } catch {
          // Reapply is best-effort; the poll still repaints on each tick.
        }

        uninstallBarangayPopupRef.current = installBarangayPopup(
          map as unknown as BarangayPopupMap,
          // Only open the panel for barangays we can resolve.
          (psgc) => (controller.infoFor(psgc) ? psgc : null),
          (psgc, lngLat) => {
            // Default the Flood Insights tab from the active layer(s):
            //   only Current on  â†’ Current; only Historical on â†’ Historical;
            //   both on (or neither) â†’ keep the user's last-selected tab.
            const currentOn = layerVisibilityRef.current.barangayFloodRisk === true;
            const historicalOn = layerVisibilityRef.current.floodSusceptibility === true;
            // In NCR overview a map tap selects the city, even when the
            // current-risk surface underneath also receives the same click.
            if (historicalOn && historicalFilterRef.current.view === 'ncr') {
              const city = historicalRiskByBarangay.get(psgc)?.cityPsgc;
              if (city) cityClickHandlerRef.current(city);
              return;
            }
            if (currentOn && !historicalOn) setInsightsTab('current');
            else if (historicalOn && !currentOn) setInsightsTab('historical');
            setInsightsSheet('half');
            setPopup({ kind: 'barangay', psgc, lngLat });
            // MAP â†’ DROPDOWN sync: when the Historical layer is the active
            // context, clicking a barangay drills the Historical filter to that
            // barangay so the Explore panel's Barangay dropdown follows the map
            // (and the selected-barangay highlight stays in agreement). Data,
            // classification and PSGC mapping are untouched â€” this only moves
            // the filter selection.
            if (historicalOn) {
              const rec = historicalRiskByBarangay.get(psgc);
              if (rec) {
                setHistoricalFilter((prev) => ({
                  ...prev,
                  view: 'barangay',
                  cityPsgc: rec.cityPsgc,
                  barangayPsgc: psgc,
                }));
              }
            }
          },
          // Also listen on the historical fill so barangay selection works when
          // only the Historical layer is visible (its polygons share the PSGC
          // feature id). Fixes dead clicks in Historical-only mode.
          [HISTORICAL_RISK_FILL_LAYER_ID],
        );

        // Map-line selection: clicking an ALTERNATIVE route line selects it,
        // synced with the route cards. Bound once; the handler ref always points
        // at the latest selection logic so it uses current options.
        uninstallRoutePreviewClickRef.current =
          manager.onRoutePreviewSelect?.((routeId) =>
            selectRouteHandlerRef.current(routeId),
          ) ?? null;

        // Point overlays: community reports + official closures. installReport-
        // Markers adds them hidden and they STAY hidden until the user enables
        // them (all thematic layers OFF on initial load).
        installReportMarkers(
          map as unknown as PointLayerMapAdapter,
          registry,
          [...communityReportFixtures],
          [...loadOfficialConfirmations()],
        );
        uninstallReportPopupRef.current = installReportPopups(
          map as unknown as ReportPopupMap,
          (data, lngLat) =>
            setPopup({
              kind: 'report',
              props: buildReportPopupProps(data),
              lngLat,
            }),
        );

        // STYLE-RELOAD SAFETY: Mapbox drops custom images on a full style
        // reload, which would blank the community pins. Re-register them on
        // styledata/style.load (hasImage-guarded, so it never throws a
        // duplicate-image error). Best-effort; teardown removes the listener.
        try {
          const styled = map as unknown as {
            on?: (t: string, l: () => void) => void;
            off?: (t: string, l: () => void) => void;
          };
          const onStyle = (): void => {
            try {
              reregisterCommunityImages(map as unknown as PointLayerMapAdapter);
            } catch {
              // Images re-register best-effort; a failure never breaks the map.
            }
          };
          styled.on?.('styledata', onStyle);
          uninstallMarkerImageReloadRef.current = () => styled.off?.('styledata', onStyle);
        } catch {
          // Best-effort.
        }

        // HISTORICAL Flood Evidence overlay (DEMO / RESEARCH USE ONLY, NOT
        // CURRENT CONDITIONS). Its own try so a failure never affects the map.
        // Installed hidden; the panel toggles it. Context only — it never
        // participates in current-risk, closures, or routing.
        try {
          installHistoricalEvidence(
            map as unknown as HistoricalLayerMapAdapter,
            historicalFloodEvidence,
          );
          const uninstallSelection = installHistoricalEvidenceSelection(
            map as unknown as BarangayPopupMap,
            (id) => evidenceSelectRef.current(id),
          );
          const styledHist = map as unknown as {
            on?: (t: string, l: () => void) => void;
            off?: (t: string, l: () => void) => void;
          };
          const onHistStyle = (): void => {
            try {
              reregisterHistoricalEvidenceImage(map as unknown as HistoricalLayerMapAdapter);
            } catch {
              // Best-effort re-register on style reload.
            }
          };
          styledHist.on?.('styledata', onHistStyle);
          uninstallHistoricalImageReloadRef.current = () => {
            uninstallSelection();
            styledHist.off?.('styledata', onHistStyle);
          };
        } catch {
          // Historical overlay is best-effort context; never blocks the map.
        }
      } catch {
        // Barangay integration is best-effort; the rest of the map stays usable.
      }

      // ALWAYS-ON base geographic context: NCR City/LGU boundaries + labels.
      // Independent of every thematic layer (no toggle) and of the rainfall/
      // risk pipeline. Installed last so the city name labels sit on top and
      // stay readable; its own try so a failure never affects other layers.
      try {
        installCityContext(map as unknown as CityContextMapAdapter);
      } catch {
        // City context is best-effort base decoration.
      }
    } catch {
      // Integration is best-effort; the base map + controls stay usable.
    }
  }

  /** Ensures a MarkerManager exists over the real map (lazy, real-map only). */
  function ensureMarkerManager(): MarkerManager | null {
    if (markerManagerRef.current) return markerManagerRef.current;
    const map = managerRef.current?.getMap?.() ?? null;
    if (!map) return null;
    const factory =
      createMarkerManager ?? ((options: MarkerManagerOptions) => new MarkerManager(options));
    try {
      const manager = factory({ map, markerFactory: mapboxMarkerFactory });
      markerManagerRef.current = manager;
      return manager;
    } catch {
      return null;
    }
  }

  // Enhancement: Escape closes an open popup regardless of where focus is.
  const popupOpen = popup !== null;
  useEffect(() => {
    if (!popupOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPopup(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popupOpen]);

  // Selected-barangay highlight: mirror the open barangay popup to the map's
  // `selected` feature-state so exactly one barangay gets the stronger outline.
  // Clears when the popup closes or a non-barangay popup opens.
  const selectedPsgc = popup?.kind === 'barangay' ? popup.psgc : null;
  const previousSelectedRef = useRef<string | null>(null);
  /** Tracks the historical-layer selection so it can be cleared on change. */
  const historicalSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const map = managerRef.current?.getMap?.() ?? null;
    setSelectedBarangay(
      map as FeatureStateMap | null,
      selectedPsgc,
      previousSelectedRef.current,
    );
    previousSelectedRef.current = selectedPsgc;
  }, [selectedPsgc]);

  const handleZoomIn = (): void => managerRef.current?.zoomIn?.();
  const handleZoomOut = (): void => managerRef.current?.zoomOut?.();
  const handleRecenter = (): void => managerRef.current?.recenter?.();

  const handleSelectCameraFromList = useCallback(
    (camera: MetroManilaTrafficCamera): void => {
      managerRef.current?.easeTo?.({
        center: [...camera.coordinates],
        zoom: 14,
        duration: 450,
      });
      cameraMarkerManagerRef.current?.openPopupForCamera(camera);
    },
    [],
  );

  // Map rotation: current bearing (degrees), kept in sync with the map so the
  // compass needle reflects rotation done via gestures too.
  const [bearing, setBearing] = useState(0);
  const handleRotateBy = (deltaDeg: number): void => {
    managerRef.current?.rotateBy?.(deltaDeg);
  };
  const handleResetNorth = (): void => {
    managerRef.current?.resetNorth?.();
  };

  // 2D/3D view. Starts in 2D (the existing overview); 3D keeps center/zoom.
  const [is3D, setIs3D] = useState(false);
  const handleViewModeToggle = (next: boolean): void => {
    // The driver view owns the camera while a drive is running.
    if (simulatorRef.current) return;
    setIs3D(next);
    managerRef.current?.set3D?.(next);
  };

  /**
   * Switches the MAP CONTEXT presentation (NCR-only â†” nearby areas). Purely a
   * basemap-presentation change routed to MapManager.setMapContext; it does NOT
   * touch flood-layer selections, rainfall, or risk state. Preserved in React
   * state for the session so it survives drawer open/close.
   */
  const handleMapContextChange = (next: MapContext): void => {
    setMapContext(next);
    mapContextRef.current = next;
    managerRef.current?.setMapContext?.(next);
  };

  // Trip flow: Search â†’ Compare â†’ Navigate. The commuter first plans a trip
  // (origin/destination), compares flood-aware routes, then presses Start to
  // enter Driver Mode. Driver Mode is NEVER the first interaction and there is
  // no standalone Play button.
  type TripStage = 'search' | 'comparing' | 'navigating';
  const [tripStage, setTripStage] = useState<TripStage>('search');
  const [routePanelMinimized, setRoutePanelMinimized] = useState(false);
  const [routePanelSession, setRoutePanelSession] = useState(0);
  const [tripOrigin, setTripOrigin] = useState<TripEndpoint | null>(null);
  const [tripDestination, setTripDestination] = useState<TripEndpoint | null>(null);
  const [routeOptions, setRouteOptions] = useState<readonly RouteOption[]>([]);
  /** The route id selected in the preview (drives map emphasis + Start). */
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  /** Active travel mode for route planning (Drive/Bike/Walk). */
  const [travelMode, setTravelMode] = useState<TravelMode>('drive');
  /** Active route preference (ranking only; never changes geometry). */
  const [routePreference, setRoutePreference] =
    useState<RoutePreference>('lowerFloodExposure');
  /**
   * True once the user has EXPLICITLY picked a route card/line, so a preference
   * change preserves their choice instead of snapping to the new recommended.
   */
  const manualRouteSelectionRef = useRef<boolean>(false);
  /** Which endpoint (if any) is being picked by tapping the map. */
  const [pickTarget, setPickTarget] = useState<PickTarget>(null);
  const pickTargetRef = useRef<PickTarget>(null);
  /** True while "report flooding" map-pick mode is active (next tap = report). */
  const [reportPickActive, setReportPickActive] = useState(false);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [controlPanel, setControlPanel] = useState<'layers' | 'cameras' | null>(null);
  const reportPickActiveRef = useRef(false);
  /**
   * HISTORICAL Flood Evidence panel open state (DEMO / RESEARCH USE ONLY). When
   * open, the historical overlay is shown; closing hides it again. Historical
   * evidence is context only and never affects current risk/closures/routing.
   */
  const [showHistoricalEvidence, setShowHistoricalEvidence] = useState(false);
  /**
   * The ACTIVE map interaction mode, surfaced by the segmented MapModeSwitcher.
   * Exactly one of Route / Community / Historical is active at a time so the
   * three surfaces never crowd the screen together. This is a presentation
   * coordinator ONLY — it reuses the existing report + historical states and
   * never changes flood semantics (Historical stays demo/research context).
   */
  const [mapMode, setMapMode] = useState<MapMode>('route');
  /**
   * True once the user has RUN the Historical Flood Evidence Agent in the
   * panel. The historical markers stay OFF the map until this is true, so the
   * on-map reveal reads as the agent's OUTPUT (research → map) rather than
   * appearing just because the panel opened. Reset whenever Historical mode is
   * left, so re-entering requires running the agent again.
   */
  const [historicalAgentRan, setHistoricalAgentRan] = useState(false);
  /**
   * The map point the user tapped in report mode, awaiting the report FORM
   * (Community Report V2). Null when no report is being composed. When set, the
   * ReportForm is shown; submitting it creates the UNCONFIRMED community report.
   */
  const [pendingReportPoint, setPendingReportPoint] = useState<{ lng: number; lat: number } | null>(
    null,
  );
  /**
   * The id of a community report whose conditions the user is editing
   * ("Conditions changed"). Null when not editing. Reuses the ReportForm.
   */
  const [conditionsEditId, setConditionsEditId] = useState<string | null>(null);
  /** A transient trip-flow notice (e.g. out-of-NCR tap/location). */
  const [tripNotice, setTripNotice] = useState<string | null>(null);
  /** True while route geometry is being fetched (disables Find routes). */
  const [findingRoutes, setFindingRoutes] = useState(false);
  /**
   * Device-location permission state. PRIVACY-FIRST: starts 'notRequested' and
   * only advances after the user explicitly consents in the BahaRoute dialog.
   * Held as runtime/session state only â€” never persisted, and precise
   * coordinates are never written to storage or logged.
   */
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('notRequested');
  /** Whether the BahaRoute location-consent dialog is open. */
  const [consentOpen, setConsentOpen] = useState(false);
  /**
   * True once the user has consented to device location THIS SESSION. Lets the
   * location arrow reuse the grant (fetch position + recenter) without showing
   * the consent dialog again. Session-only; never persisted.
   */
  const sessionLocationGrantedRef = useRef(false);

  // Driver Mode. While it runs, the normal controls + trip panels are replaced
  // by the driving HUD (next turn, flood-ahead banner, trip progress).
  const driving = tripStage === 'navigating';
  const [nav, setNav] = useState<NavState | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<FloodVoiceStatus>('ready');
  const voiceAgentRef = useRef<FloodVoiceAgent | null>(null);
  if (!voiceAgentRef.current) voiceAgentRef.current = new FloodVoiceAgent(setVoiceStatus);
  const [driveCamera, setDriveCameraState] = useState<DriveCameraMode>('driver');
  const [driveRadius, setDriveRadiusState] = useState<DriveRadius>(250);
  const [drivePlaybackRate, setDrivePlaybackRate] = useState<SimPlaybackRate>(SIM_PLAYBACK_RATE);
  const drivePlaybackRateRef = useRef<SimPlaybackRate>(SIM_PLAYBACK_RATE);
  const simulatorRef = useRef<DriveSimulator | null>(null);
  const handleDrivePlaybackRate = (rate: SimPlaybackRate): void => {
    drivePlaybackRateRef.current = rate;
    setDrivePlaybackRate(rate);
    simulatorRef.current?.setPlaybackRate(rate);
  };
  /** Last rendered HUD key: only re-render React when displayed text changes. */
  const navKeyRef = useRef('');
  /**
   * The active route summary shown in Driver Mode (aggregate route risk +
   * freshness), captured at Start from the chosen option so GPS ticks do NOT
   * re-query the environment on every frame. A separate cached snapshot.
   */
  const [driveRisk, setDriveRisk] = useState<RouteOption | null>(null);

  // Keep moving while the driver reviews flood-avoiding alternatives.
  const [offer, setOffer] = useState<RerouteOffer | null>(null);
  const [routeOffers, setRouteOffers] = useState<readonly RerouteOffer[]>([]);
  const routeOffersRef = useRef<readonly RerouteOffer[]>([]);
  const continuedHazardsRef = useRef(new Set<string>());
  const offerDisplayKeyRef = useRef('');
  const [rerouteStatus, setRerouteStatus] = useState<'searching' | 'unavailable' | null>(null);
  const rerouteGenerationRef = useRef(0);
  const requestedReroutesRef = useRef(new Set<string>());
  const reroutePendingRef = useRef(false);
  const rerouteAttemptMRef = useRef(-Infinity);
  const floodPointsRef = useRef<Array<[number, number]>>([]);
  const locatedFloodsRef = useRef<LocatedRouteFlood[]>([]);
  const reportedFloodsRef = useRef<LocatedRouteFlood[]>([]);
  useEffect(() => {
    let cancelled = false;
    const reportLayers = source.listLayers().filter((layer) => layer.id === 'floodReports' || layer.id === 'communityReports');
    void Promise.allSettled(reportLayers.map((layer) => source.getLayer<FloodReport>(layer.id).load())).then((results) => {
      if (cancelled) return;
      reportedFloodsRef.current = results.flatMap((result) => result.status === 'fulfilled'
        ? collectReportedFloods(result.value.items ?? [], result.value.isDemo) : []);
      if (simulatorRef.current) {
        locatedFloodsRef.current = [...locatedFloodsRef.current.filter((f) => !f.hazard.id.startsWith('report:')), ...reportedFloodsRef.current];
        floodPointsRef.current = locatedFloodsRef.current.map((f) => f.position);
        activeHazardsRef.current = floodHazardsOnRoute(activeBaseRouteRef.current.points, locatedFloodsRef.current);
      }
    });
    return () => { cancelled = true; };
  }, [source]);
  /** Hazards still ahead on the ACTIVE route (empty after a reroute). */
  const activeHazardsRef = useRef<ReadonlyArray<DriveHazard>>([]);
  /** Reroutes available on the ACTIVE route (empty for non-demo routes). */
  const activeReroutesRef = useRef<ReadonlyArray<FloodReroute>>([]);
  /**
   * Measured geometry of the ACTIVE route's ORIGINAL line (reroutes branch off
   * it). For the PITXâ†’MOA demo this is BASE_ROUTE; for other routes it is that
   * route's own measurement (no reroutes offered).
   */
  const activeBaseRouteRef = useRef<MeasuredRoute>(BASE_ROUTE);
  /** Maneuvers of the ACTIVE route's original line (for reroute stitching). */
  const activeBaseManeuversRef = useRef<ReadonlyArray<RouteManeuver>>(PITX_TO_MOA_MANEUVERS);
  const activeDurationSRef = useRef(0);
  /** Latest frame, so a tap uses the vehicle's current position. */
  const lastFrameRef = useRef<DriveFrame | null>(null);

  const stopDrive = (): void => {
    rerouteGenerationRef.current += 1;
    requestedReroutesRef.current.clear();
    reroutePendingRef.current = false;
    rerouteAttemptMRef.current = -Infinity;
    setRerouteStatus(null);
    routeOffersRef.current = [];
    setRouteOffers([]);
    continuedHazardsRef.current.clear();
    voiceAgentRef.current?.stop();
    simulatorRef.current?.stop();
    simulatorRef.current = null;
    managerRef.current?.endDriveView?.();
    navKeyRef.current = '';
    activeHazardsRef.current = [];
    activeReroutesRef.current = [];
    lastFrameRef.current = null;
    setOffer(null);
    setNav(null);
    setDriveRisk(null);
    // Return to the comparison so the commuter can pick another route or search.
    setPopup(null);
    setRoutePanelMinimized(false);
    setTripStage(routeOptions.length > 0 ? 'comparing' : 'search');
    if (routeOptions.length > 0 && tripOrigin && tripDestination) {
      managerRef.current?.showRoutePreview?.(
        previewRoutesFor(routeOptions),
        selectedRouteId ?? '',
        [
          [tripOrigin.coord[0], tripOrigin.coord[1]],
          [tripDestination.coord[0], tripDestination.coord[1]],
        ],
      );
    }
  };

  /** Calculate joinable alternatives ahead of the moving vehicle. */
  const requestDynamicReroute = async (hazardId: string): Promise<void> => {
    const frame = lastFrameRef.current;
    if (!frame || requestedReroutesRef.current.has(hazardId)) return;
    requestedReroutesRef.current.add(hazardId);
    reroutePendingRef.current = true;
    rerouteAttemptMRef.current = frame.traveledM;
    setRerouteStatus('searching');
    const generation = ++rerouteGenerationRef.current;
    const base = activeBaseRouteRef.current;
    const destination = base.points[base.points.length - 1];
    const hazard = activeHazardsRef.current.find((h) => h.id === hazardId);
    // Request from an upcoming road position so the vehicle can join after the response arrives.
    const leadM = Math.min(350, Math.max(0, ((hazard?.atM ?? frame.traveledM) - frame.traveledM) * 0.4));
    const routingM = Math.min(base.length, Math.max(frame.traveledM, (hazard?.atM ?? frame.traveledM) - 900) + leadM);
    const routingPosition = pointAlong(base, routingM);
    try {
      // Join every available bundled alternative from the upcoming road position.
      const existingRoads: FloodReroute[] = routeOptions.map(({ candidate }) => ({
        hazardId, fromM: 0, route: candidate.route, maneuvers: candidate.maneuvers,
        distanceM: candidate.distanceM, originalRemainingM: base.length,
      }));
      const bundled = [...activeReroutesRef.current, ...existingRoads].flatMap((reroute) => {
        const branch = branchPoint(activeBaseRouteRef.current, reroute);
        if (!branch || branch.baseM < routingM) return [];
        const next = stitchReroute(activeBaseRouteRef.current, activeBaseManeuversRef.current, reroute, routingM);
        if (!next || !avoidsFloodPoints(next.route, floodPointsRef.current)) return [];
        return [{ id: `bundled-${reroute.hazardId}-${reroute.fromM}`, label: 'Bundled flood-avoiding road route',
          route: next.route, maneuvers: next.maneuvers, distanceM: next.lengthM,
          durationS: next.lengthM / SIM_SPEED_MPS, hazards: [] }];
      });
      const context = routePlanningContext();
      const speed = activeDurationSRef.current > 0 ? frame.lengthM / activeDurationSRef.current : SIM_SPEED_MPS;
      const publish = (options: readonly RerouteOffer[]): void => {
        const current = lastFrameRef.current;
        const verified = current ? options.flatMap((option) => {
          const joined = rebaseMovingReroute(option, activeBaseRouteRef.current, activeBaseManeuversRef.current, current.traveledM, floodPointsRef.current);
          return joined ? [joined] : [];
        }) : [];
        routeOffersRef.current = verified;
        setRouteOffers(verified);
        setOffer(verified[0] ?? null);
      };
      publish(rankFloodAvoidingOffers(bundled, routingPosition, destination, floodPointsRef.current,
        hazardId, frame.lengthM - routingM, speed, context));
      const result = await findFloodAvoidingReroutes(
        routingPosition, destination, floodPointsRef.current, hazardId,
        frame.lengthM - routingM, speed,
        { mapboxToken: config.tileKey, mode: travelMode }, context, bundled,
      );
      if (generation !== rerouteGenerationRef.current) return;
      publish(result);
      setRerouteStatus(routeOffersRef.current.length ? null : 'unavailable');
    } catch {
      if (generation === rerouteGenerationRef.current) setRerouteStatus('unavailable');
    } finally {
      if (generation === rerouteGenerationRef.current) reroutePendingRef.current = false;
    }
  };

  /** Plays `route` (optionally from `fromM`), driving the camera + HUD. */
  const runSimulator = (
    manager: MapManagerLike,
    route: ReadonlyArray<[number, number]>,
    maneuvers: ReadonlyArray<RouteManeuver>,
    fromM = 0,
  ): void => {
    simulatorRef.current?.stop();
    // Measure the SAME geometry the simulator drives (dev diagnostics only).
    const measuredForDiag = measureRoute(route);
    lastFrameRef.current = null;
    const simulator: DriveSimulator = new DriveSimulator({
      route,
      playbackRate: drivePlaybackRateRef.current,
      onFrame: (frame) => {
        lastFrameRef.current = frame;
        logDriveFrame(measuredForDiag, frame);
        manager.updateDrive?.(frame);
        voiceAgentRef.current?.update(frame, measuredForDiag, activeHazardsRef.current);
        const state = computeNavState(
          frame.traveledM,
          frame.lengthM,
          maneuvers,
          activeHazardsRef.current,
          activeDurationSRef.current > 0 ? frame.lengthM / activeDurationSRef.current : SIM_SPEED_MPS,
          measuredForDiag,
        );
        const upcomingHazard = activeHazardsRef.current.find((h) => h.atM >= frame.traveledM && h.atM - frame.traveledM <= 2500);
        if (upcomingHazard && !continuedHazardsRef.current.has(upcomingHazard.id) &&
          (!requestedReroutesRef.current.has(upcomingHazard.id) ||
            (!reroutePendingRef.current && !routeOffersRef.current.length && frame.traveledM - rerouteAttemptMRef.current >= 150))) {
          // Keep moving while alternatives are calculated.
          const hazardId = upcomingHazard.id;
          requestedReroutesRef.current.delete(hazardId);
          const generation = rerouteGenerationRef.current;
          void Promise.resolve().then(() => {
            if (generation === rerouteGenerationRef.current) return requestDynamicReroute(hazardId);
          });
        }
        if (routeOffersRef.current.length) {
          const joinable = routeOffersRef.current.flatMap((option) => {
            const joined = rebaseMovingReroute(option, activeBaseRouteRef.current, activeBaseManeuversRef.current, frame.traveledM, floodPointsRef.current);
            return joined ? [joined] : [];
          });
          const displayKey = joinable.map((o) => `${o.reroute.hazardId}:${formatDistance(o.toBranchM)}`).join('|');
          if (displayKey !== offerDisplayKeyRef.current) {
            offerDisplayKeyRef.current = displayKey;
            setRouteOffers(joinable);
            setOffer(joinable[0] ?? null);
            if (!joinable.length) setRerouteStatus('unavailable');
          }
          if (!joinable.length) routeOffersRef.current = [];
        }
        const key = [
          state.next?.atM,
          formatDistance(state.toNextM),
          state.hazard?.id,
          state.hazard ? formatDistance(state.toHazardM) : '',
          formatDistance(state.remainingM),
          formatDuration(state.remainingS),
        ].join('|');
        if (key !== navKeyRef.current) {
          navKeyRef.current = key;
          setNav(state);
        }
      },
      onFinish: stopDrive,
    });
    simulatorRef.current = simulator;
    simulator.start(fromM);
  };

  // ---- Trip flow (Search â†’ Compare â†’ Start) ------------------------------

  /** Builds the live route-planning context from the risk controller. */
  const routePlanningContext = () => {
    const controller = riskControllerRef.current;
    const status = controller?.status();
    return {
      riskByBarangay: controller ? (psgc: string) => controller.riskFor(psgc) : undefined,
      reportCountByBarangay: controller
        ? (psgc: string) => controller.reportCountFor(psgc)
        : undefined,
      closedBarangays: controller?.closedBarangays(),
      trend: controller?.overallTrend(),
      dataUnavailable: status ? status.dataUnavailable || status.dataStale : true,
    };
  };

  /**
   * Compares flood-aware routes for the chosen O/D and moves to Compare. Route
   * geometry is REAL and road-following: the flagship pair uses the bundled
   * offline route; other NCR pairs are routed via Mapbox Directions (token from
   * config) so the simulated drive follows roads rather than a straight line.
   */
  const handleFindRoutes = (origin: TripEndpoint, destination: TripEndpoint): void => {
    // Drop origin/destination markers immediately (real map only; no-op in tests).
    const markerManager = ensureMarkerManager();
    markerManager?.setOrigin(origin.coord[0], origin.coord[1]);
    markerManager?.setDestination(destination.coord[0], destination.coord[1]);
    setTripStage('comparing');
    setRoutePanelMinimized(false);
    // A fresh search resets any manual selection so the recommended route wins.
    manualRouteSelectionRef.current = false;
    void computeAndShowRoutes(origin, destination, travelMode, routePreference);
  };

  /**
   * Plans routes for the given O/D + travel MODE, compares them with the current
   * live flood context + PREFERENCE, updates the cards, selects the recommended
   * route (unless a manual selection should be preserved â€” handled by callers),
   * and draws the map preview. Shared by initial search, mode change, and
   * preference change. Never fabricates routes: it shows only what the provider
   * returns. Flood-data unavailability does NOT prevent routes from showing.
   */
  const computeAndShowRoutes = async (
    origin: TripEndpoint,
    destination: TripEndpoint,
    mode: TravelMode,
    preference: RoutePreference,
    preserveSelectedId: string | null = null,
  ): Promise<void> => {
    setFindingRoutes(true);
    try {
      const candidates = await planRoutes(origin.coord, destination.coord, {
        mapboxToken: config.tileKey,
        mode,
      });
      const options = compareRoutes(candidates, routePlanningContext(), preference);
      setRouteOptions(options);

      // Preserve an explicit manual selection when it still exists; otherwise
      // select the validated recommendation, or Route B when none qualifies.
      const preserved =
        preserveSelectedId != null &&
        options.some((o) => o.candidate.id === preserveSelectedId)
          ? preserveSelectedId
          : null;
      const nextId = preserved ?? getInitialRouteSelection(options)?.candidate.id ?? null;
      setSelectedRouteId(nextId);

      if (options.length > 0) {
        managerRef.current?.showRoutePreview?.(previewRoutesFor(options), nextId ?? '', [
          [origin.coord[0], origin.coord[1]],
          [destination.coord[0], destination.coord[1]],
        ]);
      } else {
        managerRef.current?.clearRoutePreview?.();
      }
    } finally {
      setFindingRoutes(false);
    }
  };

  /**
   * Travel-mode change (Drive/Bike/Walk): recalculates routes for the new mode
   * (fresh geometry â€” never reused across modes), clears any manual selection,
   * and selects the newly recommended route.
   */
  const handleModeChange = (mode: TravelMode): void => {
    if (mode === travelMode) return;
    setTravelMode(mode);
    manualRouteSelectionRef.current = false;
    setSelectedRouteId(null);
    const origin = tripOrigin;
    const destination = tripDestination;
    if (origin && destination) {
      void computeAndShowRoutes(origin, destination, mode, routePreference);
    }
  };

  /**
   * Route-preference change (Lower flood exposure â†” Faster): RERANKS the
   * existing provider routes (no new fetch, geometry unchanged) and updates the
   * Recommended badge. Preserves an explicit manual selection; otherwise auto-
   * selects the new recommended route.
   */
  const handlePreferenceChange = (preference: RoutePreference): void => {
    if (preference === routePreference) return;
    setRoutePreference(preference);
    const reranked = compareRoutes(
      routeOptions.map((o) => o.candidate),
      routePlanningContext(),
      preference,
    );
    setRouteOptions(reranked);
    const keep =
      manualRouteSelectionRef.current &&
      selectedRouteId != null &&
      reranked.some((o) => o.candidate.id === selectedRouteId)
        ? selectedRouteId
        : (getInitialRouteSelection(reranked)?.candidate.id ?? null);
    setSelectedRouteId(keep);
    managerRef.current?.updateRoutePreviewSelection?.(previewRoutesFor(reranked), keep ?? '');
  };

  /** Maps compared options to the MapManager preview-route shape (id + geometry). */
  const previewRoutesFor = (
    options: readonly RouteOption[],
  ): PreviewRoute[] =>
    options.map((o) => ({
      id: o.candidate.id,
      geometry: o.candidate.route as ReadonlyArray<[number, number]>,
      markers: demoMarkersFor(o.candidate),
    }));

  /**
   * Selects a route in the preview (from a card or a map line). Updates the map
   * emphasis so the chosen route becomes dominant; this selection is what Start
   * will use. Does not enter Driver Mode.
   */
  const handleSelectRoute = (id: string): void => {
    manualRouteSelectionRef.current = true;
    setSelectedRouteId(id);
    managerRef.current?.updateRoutePreviewSelection?.(previewRoutesFor(routeOptions), id);
  };
  // Keep the map-line click handler pointing at the latest selection logic so a
  // click on an alternative route line stays in sync with the current options.
  selectRouteHandlerRef.current = handleSelectRoute;

  /**
   * Applies a normalized ORIGIN and drives the "Origin 3D Preview" camera state.
   * All three inputs (device / search / map) funnel through here so downstream
   * logic never cares which produced it. Places the origin marker and smoothly
   * focuses the origin in 3D (a preview â€” NOT Driver Mode). If a destination
   * already exists, both points are framed instead.
   */
  const applyOrigin = (endpoint: TripEndpoint): void => {
    setTripNotice(null);
    setTripOrigin(endpoint);
    const [lng, lat] = endpoint.coord;
    ensureMarkerManager()?.setOrigin(lng, lat);
    const manager = managerRef.current;
    const token = manager?.nextCameraToken?.();
    if (tripDestination) {
      manager?.framePoints?.([lng, lat], [tripDestination.coord[0], tripDestination.coord[1]], token);
    } else {
      manager?.focusOrigin?.([lng, lat], token);
    }
  };

  /**
   * Applies a normalized DESTINATION and drives the "Origin + Destination
   * Overview" camera state (fit both points). Not Driver Mode.
   */
  const applyDestination = (endpoint: TripEndpoint): void => {
    setTripNotice(null);
    setTripDestination(endpoint);
    const [lng, lat] = endpoint.coord;
    ensureMarkerManager()?.setDestination(lng, lat);
    const manager = managerRef.current;
    const token = manager?.nextCameraToken?.();
    if (tripOrigin) {
      manager?.framePoints?.([tripOrigin.coord[0], tripOrigin.coord[1]], [lng, lat], token);
    } else {
      // No origin yet: just preview the destination point.
      manager?.focusOrigin?.([lng, lat], token);
    }
  };

  /** Routes a search-panel origin/destination change through the camera logic. */
  const handleOriginChange = (endpoint: TripEndpoint | null): void => {
    if (endpoint) applyOrigin(endpoint);
    else setTripOrigin(null);
  };
  const handleDestinationChange = (endpoint: TripEndpoint | null): void => {
    if (endpoint) applyDestination(endpoint);
    else setTripDestination(null);
  };

  /** Enters/exits "select on map" mode for an endpoint (selection click priority). */
  const handlePickOnMap = (target: PickTarget): void => {
    setPickTarget(target);
    pickTargetRef.current = target;
    if (target) setTripNotice(null);
  };

  /**
   * Resolves a map tap for the active pick target into a normalized endpoint.
   * NCR-gated: a tap outside coverage surfaces the coverage message and leaves
   * the endpoint unset. Exits pick mode immediately after a valid tap.
   */
  const handleMapPick = (target: PickTarget, lng: number, lat: number): void => {
    if (!target) return;
    if (!isWithinNCR(lng, lat)) {
      setTripNotice(UNSUPPORTED_AREA_MESSAGE);
      return;
    }
    const endpoint: TripEndpoint = { label: 'Dropped pin', coord: [lng, lat], source: 'map' };
    if (target === 'origin') applyOrigin(endpoint);
    else applyDestination(endpoint);
    setPickTarget(null);
    pickTargetRef.current = null;
  };

  /**
   * Enters/exits "report flooding" mode. While active, the next NCR map tap
   * drops an UNCONFIRMED community report (see handleReportMapPick). Mutually
   * exclusive with the trip endpoint pick so a tap is never ambiguous.
   */
  const handleReportFloodingToggle = (): void => {
    const next = !reportPickActive;
    setReportPickActive(next);
    reportPickActiveRef.current = next;
    // Keep the segmented mode switcher in sync: entering report mode is
    // "Community" mode; leaving it returns to "Route". Historical is never
    // shown while reporting (exclusive surfaces).
    if (next) {
      setMapMode('community');
      setShowHistoricalEvidence(false);
      setHistoricalAgentRan(false);
      // Cancel any trip-endpoint pick so the two modes never both consume a tap.
      setPickTarget(null);
      pickTargetRef.current = null;
      setTripNotice(null);
      // ROOT-CAUSE FIX (#1/#6): entering report mode CLOSES any selected-report
      // popup and clears any pending compose state, so the lifecycle action
      // buttons (Confirm/Conditions changed/Flood cleared) can never linger
      // behind the report form. These overlays are mutually exclusive by state.
      setPopup(null);
      setPendingReportPoint(null);
      setConditionsEditId(null);
    } else {
      setMapMode('route');
    }
  };

  /**
   * Coordinates the ACTIVE map mode (Route / Community / Historical) so the
   * three surfaces are mutually exclusive. Switching modes cancels the others'
   * transient state (report-pick, compose form, historical overlay) so no two
   * can crowd the screen at once. Presentation only — never changes flood
   * semantics; Historical remains demo/research context.
   */
  const handleMapModeChange = (next: MapMode): void => {
    if (next === mapMode && next !== 'route') return;
    setMapMode(next);
    if (next === 'route') {
      setPopup(null);
      setControlPanel(null);
      setRoutePanelMinimized(false);
      setRoutePanelSession((session) => session + 1);
      // Explicit Route navigation must reclaim the panel from historical exploration.
      if (historicalVisible) handleLayerToggle('floodSusceptibility', false);
    }

    // Leaving Community: ensure report-pick + compose state are cleared.
    if (next !== 'community') {
      if (reportPickActive) {
        setReportPickActive(false);
        reportPickActiveRef.current = false;
      }
      setPendingReportPoint(null);
      setConditionsEditId(null);
    }
    // Leaving Historical: hide the evidence panel + overlay, and reset the
    // "agent ran" flag so re-entering requires running the agent again.
    if (next !== 'historical') {
      setShowHistoricalEvidence(false);
      setHistoricalAgentRan(false);
    }

    if (next === 'community') {
      // Enter report mode exactly as the report button does.
      setShowHistoricalEvidence(false);
      setReportPickActive(true);
      reportPickActiveRef.current = true;
      setPickTarget(null);
      pickTargetRef.current = null;
      setTripNotice(null);
      setPopup(null);
      setPendingReportPoint(null);
      setConditionsEditId(null);
    } else if (next === 'historical') {
      setShowHistoricalEvidence(true);
    }
  };

  /**
   * Submits a user-reported, UNCONFIRMED community flood report at the tapped
   * point. NCR-gated. The report is ALWAYS UNCONFIRMED and carries the demo
   * community source â€” a user submission can never be verified or official, and
   * (via the risk model) can at most escalate a barangay to REPORTED_FLOODING,
   * NEVER CONFIRMED_NOT_PASSABLE. Reuses the controller's addReport (which
   * recomputes risk + report count) and the marker-refresh listener.
   */
  const handleReportMapPick = (lng: number, lat: number): void => {
    if (!isWithinNCR(lng, lat)) {
      setTripNotice(UNSUPPORTED_AREA_MESSAGE);
      return;
    }
    // Community Report V2: a tap no longer creates a hardcoded report. It opens
    // the report FORM for this point; submitting the form creates the report.
    // Clear any selected-report popup + conditions edit so the new-report form
    // is the ONLY report overlay on screen (root-cause fix for #1/#6).
    setReportPickActive(false);
    reportPickActiveRef.current = false;
    setPopup(null);
    setConditionsEditId(null);
    setPendingReportPoint({ lng, lat });
  };

  /**
   * Creates an UNCONFIRMED community report from the pending point + the form's
   * structured conditions, then reveals the community-reports layer. The report
   * can at most escalate a barangay to REPORTED_FLOODING, NEVER
   * CONFIRMED_NOT_PASSABLE (official-only). Reuses addReport + the marker-refresh
   * listener. (Community Report V2 Phase 1.)
   */
  const handleReportFormSubmit = (conditions: ReportConditions): void => {
    const point = pendingReportPoint;
    const controller = riskControllerRef.current;
    if (!point || !controller) {
      setPendingReportPoint(null);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const id = `user-report-${now}-${Math.round(point.lng * 1e4)}-${Math.round(point.lat * 1e4)}`;
    const report = buildCommunityReport(
      id,
      point.lng,
      point.lat,
      conditions,
      COMMUNITY_REPORTS_DEMO_SOURCE,
      now,
    );
    controller.addReport(report);
    // Exit compose mode + ensure the layer + source reflect the new report.
    if (!layerVisibilityRef.current.communityReports) {
      handleLayerToggle(COMMUNITY_REPORTS_LAYER_ID, true);
    }
    refreshCommunityReportsSource();
    setPendingReportPoint(null);
    setConditionsEditId(null);
    // Post-submit feedback (#2): immediately SELECT/open the new report's popup
    // so the user sees it was recorded and can act on it. Consistent with the
    // marker-click architecture â€” we build the same ReportPopupData the click
    // handler would, from the report we just created.
    setPopup({
      kind: 'report',
      props: buildReportPopupProps(reportToPopupData(report)),
      lngLat: { lng: point.lng, lat: point.lat },
    });
    setTripNotice('Report submitted â€” community report, unverified.');
  };

  /**
   * Projects a CommunityReport to the same ReportPopupData shape the marker
   * click handler produces, so post-submit the new report opens through the
   * identical popup path (single source of truth for popup props).
   */
  const reportToPopupData = (report: CommunityReport): ReportPopupData => {
    const psgc = resolveBarangayForPoint(
      report.metadata.location.lng,
      report.metadata.location.lat,
    );
    return {
      kind: 'community',
      id: report.id,
      state: report.state,
      barangay: psgc ? (barangayInfoByPsgc.get(psgc)?.name ?? undefined) : undefined,
      note: report.metadata.description,
      updatedAt: report.metadata.updatedAt,
      source: report.metadata.source,
      severity: report.severity,
      depth: report.depth,
      passability: report.passability,
      lifecycle: report.lifecycle ?? 'ACTIVE',
      confirmationCount: report.confirmationCount ?? 0,
      lastConfirmedAt: report.lastConfirmedAt ?? null,
      resolvedAt: report.resolvedAt ?? null,
    };
  };

  /** Refreshes the community-reports marker source from the controller state. */
  const refreshCommunityReportsSource = (): void => {
    const controller = riskControllerRef.current;
    const liveMap = managerRef.current?.getMap?.() ?? null;
    if (!controller || !liveMap) return;
    updateCommunityReportsSource(
      liveMap as unknown as PointSourceUpdateMap,
      controller.communityReports(),
    );
  };

  /**
   * Builds the ReportPopup props for a clicked marker, wiring the Community
   * Report V2 lifecycle actions (community reports only). Each action calls the
   * controller (which recomputes risk + repaints), refreshes the marker source,
   * and closes the popup. Official closures get no actions.
   */
  const buildReportPopupProps = (data: ReportPopupData): ReportPopupProps => {
    const base: ReportPopupProps = {
      kind: data.kind,
      id: data.id,
      state: data.state,
      barangay: data.barangay,
      note: data.note,
      updatedAt: data.updatedAt,
      source: data.source,
      depth: (data.depth || undefined) as ReportPopupProps['depth'],
      passability: (data.passability || undefined) as ReportPopupProps['passability'],
      severity: (data.severity || undefined) as ReportPopupProps['severity'],
      lifecycle: data.lifecycle,
      confirmationCount: data.confirmationCount,
      lastConfirmedAt: data.lastConfirmedAt ?? undefined,
      resolvedAt: data.resolvedAt ?? undefined,
    };
    if (data.kind !== 'community' || !data.id) return base;
    const id = data.id;
    return {
      ...base,
      onConfirm: () => {
        const updated = riskControllerRef.current?.confirmReport(id);
        refreshCommunityReportsSource();
        // Keep the popup OPEN and re-render it with the incremented count +
        // last-confirmed time, so the confirmation is immediately visible on the
        // very report being confirmed (scenario: confirm â†’ count increases).
        if (updated) {
          setPopup({
            kind: 'report',
            props: buildReportPopupProps(reportToPopupData(updated)),
            lngLat: { lng: updated.metadata.location.lng, lat: updated.metadata.location.lat },
          });
        }
        setTripNotice('Thanks â€” your confirmation was recorded (community).');
      },
      onConditionsChanged: () => {
        setPopup(null);
        setConditionsEditId(id);
      },
      onResolve: () => {
        riskControllerRef.current?.resolveReport(id);
        refreshCommunityReportsSource();
        setPopup(null);
        setTripNotice('Marked as cleared â€” thanks for the update (community).');
      },
    };
  };

  /** Applies a "conditions changed" update from the form to the given report. */
  const handleConditionsUpdate = (conditions: ReportConditions): void => {
    const id = conditionsEditId;
    if (!id) return;
    riskControllerRef.current?.updateReportConditions(id, conditions);
    refreshCommunityReportsSource();
    setConditionsEditId(null);
    setTripNotice('Conditions updated â€” thanks (community).');
  };

  /**
   * Smoothly recenters/zooms back to the CURRENT origin's 3D preview without
   * changing any state â€” used when the location arrow is pressed and an origin
   * already exists. Does not touch destination, layers, or route state.
   */
  const recenterOrigin = (): void => {
    if (!tripOrigin) return;
    const manager = managerRef.current;
    manager?.focusOrigin?.(
      [tripOrigin.coord[0], tripOrigin.coord[1]],
      manager.nextCameraToken?.(),
    );
  };

  /**
   * The shared device-location fetch used by BOTH the "Use current location"
   * chip and the location arrow, AFTER consent. Requests the browser position
   * (native prompt may appear), then:
   *  - granted + in NCR â†’ set the device origin (normalized) + 3D preview,
   *  - granted + outside NCR â†’ reject cleanly with the coverage message,
   *  - denied â†’ subtle denied status (no re-prompt),
   *  - unavailable/timeout â†’ subtle unavailable status.
   * Route planning stays usable in every branch. Coordinates are never
   * persisted or logged.
   */
  const fetchDeviceOrigin = (): void => {
    setLocationStatus('requesting');
    void requestLocation()
      .then((result) => {
        if (result.status === 'denied') {
          setLocationStatus('denied');
          return;
        }
        if (result.status !== 'granted') {
          setLocationStatus('unavailable');
          return;
        }
        // A successful grant is remembered for the session so the arrow can
        // reuse it without re-showing the consent dialog.
        sessionLocationGrantedRef.current = true;
        if (!isWithinNCR(result.lng, result.lat)) {
          setLocationStatus('allowed');
          setTripNotice(UNSUPPORTED_AREA_MESSAGE);
          return;
        }
        setLocationStatus('allowed');
        applyOrigin({
          label: 'Current location',
          coord: [result.lng, result.lat],
          source: 'device',
        });
      })
      .catch(() => {
        setLocationStatus('unavailable');
      });
  };

  /**
   * "Use current location" (search panel chip). PRIVACY-FIRST: opens the
   * BahaRoute consent dialog first; geolocation is only requested after Allow.
   * If the user already granted this session, it skips straight to the fetch.
   */
  const handleUseCurrentLocation = (): void => {
    setTripNotice(null);
    if (sessionLocationGrantedRef.current) {
      fetchDeviceOrigin();
      return;
    }
    setConsentOpen(true);
  };

  /**
   * Location arrow (map control). Same consent-first contract:
   *  - never requested this session â†’ show consent, then fetch on Allow;
   *  - already granted this session + origin already set â†’ recenter to it;
   *  - already granted this session + no origin yet â†’ fetch + set origin.
   * Never resets destination, layers, or route.
   */
  const handleLocationArrow = (): void => {
    setTripNotice(null);
    if (!sessionLocationGrantedRef.current) {
      setConsentOpen(true);
      return;
    }
    if (tripOrigin && tripOrigin.source === 'device') {
      // Reuse the known device origin: recenter immediately (cheap, no fetch).
      recenterOrigin();
      return;
    }
    // Granted but no device origin yet (or origin came from search/map): fetch
    // the current position and set/recenter to it.
    fetchDeviceOrigin();
  };

  /** The user declined the consent dialog: no geolocation request occurs. */
  const handleConsentDismiss = (): void => {
    setConsentOpen(false);
  };

  /** The user consented: proceed to the (shared) geolocation fetch. */
  const handleConsentAllow = (): void => {
    setConsentOpen(false);
    fetchDeviceOrigin();
  };

  /**
   * Enters Driver Mode for the chosen route option â€” the ONLY entry into Driver
   * Mode. Captures the route's aggregate risk as a cached snapshot so GPS ticks
   * don't re-query the environment, then starts the simulator on the route.
   */
  const handleStartRoute = (option: RouteOption): void => {
    if (findingRoutes || option.candidate.id !== selectedRouteId) return;
    // Recheck the live snapshot at Start so a changed flood signal cannot leave
    // a different automatic choice or a newly closed route ready to navigate.
    const refreshed = compareRoutes(routeOptions.map((o) => o.candidate), routePlanningContext(), routePreference);
    const current = refreshed.find((o) => o.candidate.id === option.candidate.id);
    if (!current || isRouteStartBlocked(current) ||
      (!manualRouteSelectionRef.current && getInitialRouteSelection(refreshed)?.candidate.id !== current.candidate.id)) {
      setRouteOptions(refreshed);
      setSelectedRouteId(null);
      managerRef.current?.updateRoutePreviewSelection?.(previewRoutesFor(refreshed), '');
      setTripNotice('Route conditions changed. Review the suggestions and select a route again.');
      return;
    }
    option = current;
    const manager = managerRef.current;
    const candidate = option.candidate;
    // All bundled journey choices can join the verified road detours.
    const isDemoRoute = candidate.id.startsWith('pitx-moa-');
    rerouteGenerationRef.current += 1;
    requestedReroutesRef.current.clear();
    reroutePendingRef.current = false;
    rerouteAttemptMRef.current = -Infinity;
    continuedHazardsRef.current.clear();
    routeOffersRef.current = [];
    setRouteOffers([]);
    setRerouteStatus(null);
    locatedFloodsRef.current = [...collectRouteFloods(routeOptions.map((o) => o.candidate)), ...reportedFloodsRef.current];
    floodPointsRef.current = locatedFloodsRef.current.map((flood) => flood.position);
    activeHazardsRef.current = floodHazardsOnRoute(candidate.route, locatedFloodsRef.current);
    activeReroutesRef.current = isDemoRoute ? PITX_TO_MOA_REROUTES : [];
    activeBaseRouteRef.current = measureRoute(candidate.route);
    activeBaseManeuversRef.current = candidate.maneuvers;
    activeDurationSRef.current = candidate.durationS;
    setDriveRisk(option);
    setTripStage('navigating');
    voiceAgentRef.current?.start();
    // Remove the flat route-preview overlays before the Driver Mode 3D camera.
    manager?.clearRoutePreview?.();

    if (!manager?.startDriveView || !manager.updateDrive) {
      // No real map (tests): still enter navigating so the HUD renders once nav
      // is computed; the simulator needs a manager to drive the camera.
      return;
    }
    // Drive starts in the Driver camera with the tight 250 m 3D radius.
    setDriveCameraState('driver');
    setDriveRadiusState(250);
    manager.setDriveCamera?.('driver');
    manager.setDriveRadius?.(250);
    const markers = demoMarkersFor(candidate);
    manager.startDriveView(candidate.route, markers);
    runSimulator(manager, candidate.route, candidate.maneuvers);
  };

  /** Returns to the search step, clearing the comparison; reframes the trip. */
  const handleTripBack = (): void => {
    setRoutePanelMinimized(false);
    setPopup(null);
    handleMapModeChange('route');
    setRouteOptions([]);
    setSelectedRouteId(null);
    setPickTarget(null);
    pickTargetRef.current = null;
    setTripStage('search');
    managerRef.current?.clearRoutePreview?.();
    // Reframe to the current planning context: both points if present, else the
    // origin preview, else the NCR overview. Tokened to beat stale moves.
    const manager = managerRef.current;
    const token = manager?.nextCameraToken?.();
    if (tripOrigin && tripDestination) {
      manager?.framePoints?.(
        [tripOrigin.coord[0], tripOrigin.coord[1]],
        [tripDestination.coord[0], tripDestination.coord[1]],
        token,
      );
    } else if (tripOrigin) {
      manager?.focusOrigin?.([tripOrigin.coord[0], tripOrigin.coord[1]], token);
    } else {
      manager?.frameOverview?.();
    }
  };

  /**
   * Re-opens the Route Compare panel from the recoverable "Route ready" chip,
   * restoring it as the primary left panel. Closes any open barangay Insights
   * (which otherwise outranks the route panel) so exactly one panel shows.
   */
  const handleViewRoute = (): void => {
    setPopup(null);
    setRoutePanelMinimized(false);
    setTripStage('comparing');
  };

  /**
   * The SINGLE primary left panel. Exactly one of these ever occupies the left
   * rail, by priority, so two full panels can never stack on top of each other
   * (the overlap bug). A barangay selection (Flood Insights) wins; then an
   * active route comparison; then the Historical explore panel; then the trip
   * search panel. Secondary state is never destroyed â€” e.g. a ready route stays
   * in memory and is reachable via the compact "Route ready" chip.
   */
  // Report details temporarily own the rail/sheet; closing restores the trip
  // or historical panel with its existing state.
  const primaryLeftPanel: PrimaryLeftPanel = popup?.kind === 'report' ? null : resolvePrimaryLeftPanel({
    isError: phase === 'error',
    driving,
    barangaySelected: popup?.kind === 'barangay',
    comparing: mapMode === 'route' && tripStage === 'comparing',
    searching: mapMode === 'route' && tripStage === 'search',
    historicalVisible,
  });

  /**
   * A ready route exists but the Route Compare panel is NOT the primary panel
   * (Insights or Explore took the rail). Surface a compact, recoverable chip so
   * the route is never lost â€” tapping it swaps Compare back in.
   */
  const selectedRouteOption =
    routeOptions.find((o) => o.candidate.id === selectedRouteId) ?? null;
  // Fit the preview after the sheet has rendered, keeping both trip
  // markers (especially Point A) above the sheet and below mobile navigation.
  useEffect(() => {
    if (primaryLeftPanel !== 'compare' || !tripOrigin || !tripDestination) return;
    const container = containerRef.current;
    const map = managerRef.current?.getMap?.();
    if (!container || !map) return;
    const mobile = container.clientWidth < 768;
    const fit = (map as unknown as { fitBounds?: (bounds: unknown, options: unknown) => void }).fitBounds;
    if (!fit) return;
    const host = container.parentElement;
    const rect = container.getBoundingClientRect();
    const navigation = host?.querySelector('.baharoute-mode-switcher-host')?.getBoundingClientRect();
    const sheet = host?.querySelector('.baharoute-trip-host')?.getBoundingClientRect();
    const points = [tripOrigin.coord, tripDestination.coord, ...routeOptions.flatMap(option => option.candidate.route)];
    fit.call(map, [
      [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
      [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))],
    ], {
      padding: {
        top: Math.max(24, (navigation?.bottom ?? rect.top) - rect.top + 24),
        bottom: mobile ? Math.max(24, rect.bottom - (sheet?.top ?? rect.bottom) + 24) : 32,
        left: mobile ? 40 : Math.max(40, (sheet?.right ?? rect.left) - rect.left + 24),
        right: 40,
      },
      pitch: 0,
      maxZoom: 16,
      duration: 700,
    });
  }, [phase, routePanelMinimized, primaryLeftPanel, tripOrigin, tripDestination, routeOptions]);
  const showRouteReadyChip =
    !driving &&
    phase !== 'error' &&
    tripStage === 'comparing' &&
    primaryLeftPanel !== 'compare' &&
    selectedRouteOption != null;

  /**
   * Accepts the reroute FROM WHERE THE DRIVER IS: the vehicle is not moved.
   * The new route continues on the current road to the turn-off, then onto
   * the flood-avoiding road; directions and ETA update to it.
   */
  const handleReroute = (chosen?: RerouteOffer): void => {
    const manager = managerRef.current;
    const frame = lastFrameRef.current;
    const selected = chosen ?? offer;
    if (!selected || !manager || !frame) return;
    // Re-evaluate at tap time: the car kept moving since the card rendered.
    const fresh = rebaseMovingReroute(selected, activeBaseRouteRef.current, activeBaseManeuversRef.current, frame.traveledM, floodPointsRef.current);
    if (!fresh) {
      requestedReroutesRef.current.delete(selected.reroute.hazardId);
      void requestDynamicReroute(selected.reroute.hazardId);
      return;
    }
    const next = fresh.directRoute ?? stitchReroute(
      activeBaseRouteRef.current,
      activeBaseManeuversRef.current,
      fresh.reroute,
      frame.traveledM,
    );
    if (!next) return; // Not joinable on real roads (never offered in practice).
    const updated = driveRisk ? compareRoutes([{
      ...driveRisk.candidate, id: `${driveRisk.candidate.id}-rerouted`, label: 'Flood-avoiding reroute',
      route: next.route, maneuvers: next.maneuvers, distanceM: next.lengthM,
      durationS: fresh.durationS ?? next.lengthM / SIM_SPEED_MPS, hazards: [], demoFloods: [],
    }], routePlanningContext())[0] : null;
    if (!avoidsFloodPoints(next.route, floodPointsRef.current) ||
      (updated && (isRouteStartBlocked(updated) || updated.risk.level === 'REPORTED_FLOODING' || updated.risk.level === 'CONFIRMED_NOT_PASSABLE'))) {
      requestedReroutesRef.current.delete(fresh.reroute.hazardId);
      setOffer(null);
      void requestDynamicReroute(fresh.reroute.hazardId);
      return;
    }
    rerouteGenerationRef.current += 1;
    setRerouteStatus(null);
    routeOffersRef.current = [];
    setRouteOffers([]);
    voiceAgentRef.current?.cancelPending();
    // The reroute excludes every demo hazard, so none remain ahead on it.
    activeHazardsRef.current = floodHazardsOnRoute(next.route, locatedFloodsRef.current);
    activeReroutesRef.current = [];
    navKeyRef.current = '';
    setOffer(null);
    if (updated) setDriveRisk(updated);
    activeBaseRouteRef.current = measureRoute(next.route);
    activeBaseManeuversRef.current = next.maneuvers;
    activeDurationSRef.current = fresh.durationS ?? next.lengthM / SIM_SPEED_MPS;
    manager.setDriveRoute?.(next.route);
    runSimulator(manager, next.route, next.maneuvers);
  };

  const handleDriveCamera = (mode: DriveCameraMode): void => {
    setDriveCameraState(mode);
    managerRef.current?.setDriveCamera?.(mode);
  };
  const handleDriveRadius = (radius: DriveRadius): void => {
    setDriveRadiusState(radius);
    managerRef.current?.setDriveRadius?.(radius);
  };
  // Stop the animation loop if the map unmounts mid-drive.
  useEffect(() => () => {
    rerouteGenerationRef.current += 1;
    simulatorRef.current?.stop();
    voiceAgentRef.current?.stop();
  }, []);

  // Show/hide the HISTORICAL evidence overlay. Context only — this toggles ONLY
  // the historical layer and never current risk/closures. Markers appear only
  // once the panel is open AND the agent has been run (research → map reveal),
  // so an empty map before "Run" makes the web-research step legible.
  useEffect(() => {
    const liveMap = managerRef.current?.getMap?.() ?? null;
    if (!liveMap) return;
    setHistoricalEvidenceVisibility(
      liveMap as unknown as { setLayoutProperty?: (id: string, n: string, v: unknown) => unknown; getLayer?: (id: string) => unknown },
      showHistoricalEvidence && historicalAgentRan,
    );
  }, [showHistoricalEvidence, historicalAgentRan]);

  const handleLayerToggle = (id: LayerId, visible: boolean): void => {
    const registry = registryRef.current;
    const map = managerRef.current?.getMap?.() ?? null;
    // Reflect user intent in state FIRST (legends/warnings + click-priority),
    // regardless of whether a real integrable map/registry exists yet. This
    // keeps the UI consistent and testable even before real integration.
    layerVisibilityRef.current = {
      ...layerVisibilityRef.current,
      [id]: visible,
    };
    if (
      id === 'barangayFloodRisk' ||
      id === 'communityReports' ||
      id === 'officialClosures' ||
      id === 'floodSusceptibility'
    ) {
      setLayerVisible((prev) => ({ ...prev, [id]: visible }));
    }
    // Below this point we mutate the actual map layers; skip if not integrable.
    if (!registry) return;
    // The registry manages app-managed canvas layers. Some UI toggles map to
    // more than one canvas layer (a fill + its companion outline, or the two
    // baseline susceptibility surfaces), so fan out accordingly.
    const setLayout = (layerId: string): void => setLayoutVisibility(map, layerId, visible);
    const safeSet = (appId: LayerId): void => {
      try {
        registry.setVisibility(appId as never, visible);
      } catch {
        // Non-app layer ids are not registry-managed; ignore safely.
      }
    };

    switch (id) {
      case 'barangayFloodRisk':
        safeSet('barangayFloodRisk');
        setLayout('barangayFloodRisk-outline');
        break;
      case 'floodSusceptibility':
// Historical risk uses the derived city summaries at NCR scope and
        // individual barangay classes when drilled down. Legacy demo layers
        // stay hidden; the scope effect chooses the appropriate surface.
        setLayout(HISTORICAL_RISK_FILL_LAYER_ID);
        setLayout(HISTORICAL_RISK_OUTLINE_LAYER_ID);
        setLayout(HISTORICAL_SELECTED_LAYER_ID);
        setLayout(HISTORICAL_LABEL_LAYER_ID);
        setLayout(HISTORICAL_LABEL_SELECTED_LAYER_ID);
        setLayout(CITY_HISTORICAL_FILL_LAYER_ID);
        setLayout(CITY_BOUNDARY_LAYER_ID);
        setLayout(CITY_BOUNDARY_SELECTED_LAYER_ID);
        if (visible) {
          // Reapply the current filter when the layer is (re)shown.
          applyHistoricalFilter(
            map as unknown as HistoricalFeatureStateMap,
            historicalFilter,
          );
          applyCityFocus(
            map as unknown as CityBoundaryFeatureStateMap,
            historicalFilter.view === 'ncr' ? null : historicalFilter.cityPsgc,
          );
          // Scope barangay labels to the selected city (none at NCR overview)
          // AND the active risk filter, consistent with the panel + emphasis.
          applyBarangayLabelScope(
            map,
            historicalFilter.view === 'ncr' ? null : historicalFilter.cityPsgc,
            historicalFilter.risk,
          );
        }
        break;
      case 'communityReports':
        // Toggle the pin + its companion badge/hitbox layers together.
        if (registry) {
          setCommunityReportsVisibility(
            map as unknown as {
              setLayoutProperty?(id: string, name: string, value: unknown): unknown;
              getLayer?(id: string): unknown;
            },
            registry,
            visible,
          );
        }
        break;
      case 'officialClosures':
        safeSet('officialClosures');
        break;
      default:
        safeSet(id);
    }
  };

  // Derive the open barangay panel's props at render time from the controller,
  // the selected timeline step, and the latest risk revision. This keeps a
  // clicked barangay live: poll ticks and timeline changes re-derive the panel.
  const barangayPanelProps =
    popup?.kind === 'barangay'
      ? (riskControllerRef.current?.infoFor(popup.psgc, timelineStep) ?? null)
      : null;
  // `riskRevision` is intentionally read so the panel re-derives on repaint.
  void riskRevision;
  /** Timeline changes update the open panel + map coloring for the step. */
  const handleTimelineStep = (step: TimelineStep): void => {
    setTimelineStep(step);
    riskControllerRef.current?.setTimelineStep?.(step);
  };

  useEffect(() => {
    const map = managerRef.current?.getMap?.() ?? null;
    if (!map) return;
    setHistoricalHover(null);
    setCityHover(null);
    applyHistoricalCityScope(map, historicalFilter);
    const overview = historicalFilter.view === 'ncr' || !historicalFilter.cityPsgc;
    setLayoutVisibility(map, CITY_HISTORICAL_FILL_LAYER_ID, historicalVisible && overview);
    for (const id of [HISTORICAL_RISK_FILL_LAYER_ID, HISTORICAL_RISK_OUTLINE_LAYER_ID]) {
      setLayoutVisibility(map, id, historicalVisible && !overview);
    }
  }, [historicalVisible, historicalFilter, phase]);

  /**
   * Reapply the historical filter to the map whenever it changes. Writing the
   * `histShown` feature-state per barangay drives which polygons render; the
   * class colors themselves are static and set once on install. Runs only when
   * a real (integrable) map is present.
   */
  useEffect(() => {
    const map = managerRef.current?.getMap?.() ?? null;
    if (!map || typeof (map as { setFeatureState?: unknown }).setFeatureState !== 'function') {
      return;
    }
    const fsMap = map as unknown as HistoricalFeatureStateMap;
    // 1) Dim-not-hide 3-tier emphasis for every barangay under the active
    //    filter (selected barangay > in-scope > out-of-scope).
    applyHistoricalFilter(fsMap, historicalFilter);
    // 1b) City-focus boundaries: emphasize the selected city, mute the rest.
    //     NCR view clears focus (all boundaries subtle + equal).
    const focusCity =
      historicalFilter.view === 'ncr' ? null : historicalFilter.cityPsgc;
    applyCityFocus(map as unknown as CityBoundaryFeatureStateMap, focusCity);

    // 1c) Scope the zoom-aware barangay name labels to the selected city (none
    //     at NCR overview) AND the active risk filter, so the visible labels
    //     stay consistent with the panel count + fill emphasis.
    applyBarangayLabelScope(map, focusCity, historicalFilter.risk);
  }, [historicalFilter]);

  // Risk-class changes repaint the layer without interrupting a pan/zoom.
  useEffect(() => {
    const map = managerRef.current?.getMap?.() ?? null;
    if (!map) return;
    // Camera framing: zoom to the selected city / barangay, or back to the
    //    NCR overview for the NCR view. Bounded padding + maxZoom keeps tiny
    //    barangays from over-zooming and large ones from under-zooming.
    const fit = (map as unknown as {
      fitBounds?: (b: unknown, o?: unknown) => void;
    }).fitBounds;
    if (typeof fit !== 'function') return;
    try {
      if (historicalFilter.view === 'barangay' && historicalFilter.barangayPsgc) {
        const b = barangayBounds(historicalFilter.barangayPsgc);
        if (b) fit.call(map, b, { padding: 96, maxZoom: 15.5, duration: 700 });
      } else if (historicalFilter.view === 'city' && historicalFilter.cityPsgc) {
        const b = cityBounds(historicalFilter.cityPsgc);
        if (b) fit.call(map, b, { padding: 64, maxZoom: 14, duration: 700 });
      } else if (historicalFilter.view === 'ncr') {
        managerRef.current?.frameOverview?.();
      }
    } catch {
      // Camera framing is best-effort; emphasis already applied.
    }
  }, [historicalFilter.view, historicalFilter.cityPsgc, historicalFilter.barangayPsgc]);

  /**
   * Leaving the Barangay drill-down (breadcrumb back to City or NCR) closes the
   * open barangay panel, so its highlight/label clear and the city returns to
   * its normal per-barangay colors.
   */
  const prevHistoricalViewRef = useRef(historicalFilter.view);
  useEffect(() => {
    const prev = prevHistoricalViewRef.current;
    prevHistoricalViewRef.current = historicalFilter.view;
    if (prev === 'barangay' && historicalFilter.view !== 'barangay') {
      setPopup((p) => (p?.kind === 'barangay' ? null : p));
    }
  }, [historicalFilter.view]);

  /**
   * Keep the historical layer's SELECTED (strong-outline) barangay in sync with
   * the panel. The selection is the clicked barangay (Flood Insights open) or,
   * failing that, the Barangay-view filter selection â€” so map and panel always
   * agree on which barangay is highlighted. Single writer for the selection
   * feature-state (avoids conflicting updates).
   */
  useEffect(() => {
    const map = managerRef.current?.getMap?.() ?? null;
    if (!map || typeof (map as { setFeatureState?: unknown }).setFeatureState !== 'function') {
      return;
    }
    const clicked = popup?.kind === 'barangay' ? popup.psgc : null;
    const next =
      clicked ??
      (historicalFilter.view === 'barangay' ? historicalFilter.barangayPsgc : null);
    setSelectedHistoricalBarangay(
      map as unknown as HistoricalFeatureStateMap,
      next,
      historicalSelectedRef.current,
    );
    historicalSelectedRef.current = next;
    // Always-visible selected-barangay label follows the same selection, so the
    // chosen polygon's name + class stay readable at every zoom (even the city
    // overview). Scoped to the single selected psgc (nothing when none).
    const sf = (map as { setFilter?: (id: string, f: unknown) => void }).setFilter;
    if (typeof sf === 'function') {
      try {
        sf.call(map, HISTORICAL_LABEL_SELECTED_LAYER_ID, selectedLabelFilter(next));
      } catch {
        // Best-effort; the polygon highlight already conveys selection.
      }
    }
  }, [popup, historicalFilter]);

  /**
   * Scopes the zoom-aware barangay NAME labels to a single city (or none).
   * Uses Mapbox `setFilter` on the label layer with {@link cityLabelFilter}, so
   * only the selected city's barangays are label candidates â€” never all 1,710
   * NCR barangays, and nothing at the NCR overview. Best-effort / no-op on a
   * fake map (tests) or before the layer exists.
   */
  const applyBarangayLabelScope = (
    map: unknown,
    cityPsgc: string | null,
    risk: HistoricalFilterState['risk'] = 'all',
  ): void => {
    const m = map as { setFilter?: (id: string, filter: unknown) => void };
    if (typeof m.setFilter !== 'function') return;
    try {
      const scope = historicalFilterRef.current;
      m.setFilter(HISTORICAL_LABEL_LAYER_ID,
        scope.view === 'barangay' && scope.barangayPsgc
          ? ['==', ['get', 'psgc'], scope.barangayPsgc]
          : cityLabelFilter(cityPsgc, risk));
    } catch {
      // Label scoping is best-effort; the fill/hover/click still work.
    }
  };

  /**
   * Clicking a city boundary on the map selects that city: switch to City view,
   * set the city, and clear any barangay selection. Kept in a ref so the
   * once-bound map click always uses the current setter. Only meaningful while
   * the Historical layer is visible + the user is in a city-capable view.
   */
  const handleCityMapSelect = (cityPsgc: string): void => {
    if (!historicalVisible || (historicalFilter.view !== 'ncr' && historicalFilter.cityPsgc)) return;
    setPopup(null);
    setHistoricalFilter((prev) => ({
      ...prev,
      view: 'city',
      cityPsgc,
      barangayPsgc: null,
    }));
  };
  cityClickHandlerRef.current = handleCityMapSelect;

  const selectHistoricalBarangay = (psgc: string): void => {
    const record = historicalRiskByBarangay.get(psgc);
    if (!record) return;
    keepHistoricalHover();
    setHistoricalHover(null);
    setCityHover(null);
    setHistoricalFilter({ view: 'barangay', cityPsgc: record.cityPsgc, barangayPsgc: psgc, risk: 'all' });
    setInsightsTab('historical');
    setInsightsSheet('half');
    setPopup({ kind: 'barangay', psgc });
  };
  const selectHistoricalEvidence = (item: (typeof historicalFloodEvidence)[number]): void => {
    if (item.coordinates) {
      const manager = managerRef.current;
      const map = manager?.getMap?.() as { flyTo?: (options: unknown) => void } | null;
      const width = containerRef.current?.clientWidth || window.innerWidth;
      const height = containerRef.current?.clientHeight || window.innerHeight;
      const desktop = width >= 768;
      const options = {
        center: [...item.coordinates],
        zoom: 15.5,
        duration: 1000,
        // Keep the selected point visible beside the panel / above the mobile sheet.
        offset: desktop
          ? [Math.min(200, width * 0.2), 0]
          : [0, -Math.min(160, height * 0.2)],
      };
      if (manager?.flyTo) manager.flyTo(options);
      else map?.flyTo?.(options);
    }
    setPopup({
      kind: 'historical',
      evidenceId: item.id,
      props: {
        title: item.title,
        city: item.city,
        eventLabel: item.eventLabel,
        eventDate: item.eventDate,
        publicationDate: item.publicationDate,
        floodCondition: item.floodCondition,
        reportedDepth: item.reportedDepth,
        passability: item.passability,
        sourceName: item.sourceName,
        sourceUrl: item.sourceUrl,
        locationPrecision: item.locationPrecision,
      },
      lngLat: item.coordinates
        ? { lng: item.coordinates[0], lat: item.coordinates[1] }
        : undefined,
    });
  };
  evidenceSelectRef.current = (id) => {
    const item = historicalFloodEvidence.find((record) => record.id === id);
    if (item) selectHistoricalEvidence(item);
  };

  /**
   * Visual co-existence when BOTH flood layers are enabled: the historical fill
   * recedes to a faint overlay while the user's focus is Current (a barangay is
   * open on the Current tab), so the warm historical fill and the
   * green→red current fill never stack into a muddy double-fill. When only
   * Historical is on — or the Historical tab is active — it returns to its full
   * fill. Paint-only; no data/feature-state/classification is touched.
   */
  useEffect(() => {
    const map = managerRef.current?.getMap?.() ?? null;
    if (!map || typeof (map as { setPaintProperty?: unknown }).setPaintProperty !== 'function') {
      return;
    }
    const bothOn = floodRiskVisible && historicalVisible;
    const barangayOpen = popup?.kind === 'barangay';
    // When both layers are on, exactly ONE is the primary fill; the other
    // recedes so the two color families never stack into muddy colors:
    //   focus Current (Current tab) → current keeps its fill
    //   focus Historical (Historical tab open or Explore) → current fill hidden
    //   drilled into a city/barangay in the Historical panel with no barangay
    //   panel open → historical is the focus (its city colors come back)
    const historicalIsFocus =
      bothOn &&
      (barangayOpen ? insightsTab === 'historical' : true);
    const dimCurrent = historicalIsFocus;

    setPaint(
      map,
      HISTORICAL_RISK_FILL_LAYER_ID,
      'fill-opacity',
      historicalFillOpacityExpression(),
    );
    setPaint(
      map,
      BARANGAY_RISK_FILL_LAYER_ID,
      'fill-opacity',
      dimCurrent ? 0 : barangayRiskFillOpacityExpression(),
    );
  }, [floodRiskVisible, historicalVisible, insightsTab, popup, historicalFilter.view]);

  return (
    <div className="baharoute-map-view" data-testid="map-view" data-control-panel={controlPanel ?? undefined}>
      <div
        ref={containerRef}
        className="baharoute-map"
        data-testid="map-container"
        role="application"
        aria-label="Metro Manila interactive map"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />

      {/* Loading overlay: shown while tiles load, dismissed on ready (Req 1.5). */}
      {phase === 'loading' && <LoadingIndicator />}

      {/* Error overlay: shown on tile failure/timeout; app stays interactive. */}
      {phase === 'error' && <ErrorMessage reason={failureReason ?? undefined} />}

      {/* Demo-data badge: visible whenever demo/fixture layers are present. */}
      {hasDemoLayers && <DemoDataBadge />}

      {/* Coverage scope: BahaRoute is NCR-only. Subtle, always visible when the
          map is up (hidden while driving to keep the HUD clean). */}
      {phase !== 'error' && !driving && <CoverageBadge />}

      {/*
        Control cluster over the map. Placement is driven entirely by the
        `baharoute-controls` class in src/styles/layout.css, whose CSS
        custom-property tokens switch at the 768px breakpoint (Task 16):
        mobile anchors the cluster to the lower two-thirds (bottom), desktop
        flips it to a spaced top-right column. The hardcoded inline
        right/top positioning was removed in favor of that class.
      */}
      {/* Driving mode replaces the normal controls + legend while a drive runs. */}
      {driving && nav && (
        <DrivingHud
          nav={nav}
          voiceStatus={voiceStatus}
          onVoiceToggle={() => voiceAgentRef.current?.setEnabled(voiceStatus !== 'ready')}
          camera={driveCamera}
          radius={driveRadius}
          playbackRate={drivePlaybackRate}
          onPlaybackRateChange={handleDrivePlaybackRate}
          onCameraChange={handleDriveCamera}
          onRadiusChange={handleDriveRadius}
          onStop={stopDrive}
        >
          {nav.hazard && !continuedHazardsRef.current.has(nav.hazard.id) ? (
            <RerouteOfferCard
              offer={offer} alternatives={routeOffers} status={rerouteStatus}
              hazard={nav.hazard} toHazardM={nav.toHazardM} onReroute={handleReroute}
              onKeep={() => {
                if (nav.hazard?.passability !== 'passable') return;
                continuedHazardsRef.current.add(nav.hazard.id);
                rerouteGenerationRef.current += 1;
                routeOffersRef.current = [];
                setRouteOffers([]);
                setOffer(null);
                setRerouteStatus(null);
              }}
              onReview={stopDrive}
              onRetry={() => {
                if (!nav.hazard) return;
                requestedReroutesRef.current.delete(nav.hazard.id);
                void requestDynamicReroute(nav.hazard.id);
              }}
            />
          ) : driveRisk && <DriveRiskBanner option={driveRisk} status={riskStatus} />}
        </DrivingHud>
      )}

      <div
        className="baharoute-controls"
        data-testid="map-controls"
        data-sheet-open={primaryLeftPanel !== null ? 'true' : undefined}
        data-mobile-open={mobileControlsOpen ? 'true' : undefined}
        hidden={driving}
        style={driving ? { display: 'none' } : undefined}
      >
        <button
          type="button"
          className="baharoute-mobile-menu-button baharoute-round-button baharoute-focus-ring"
          data-testid="controls-menu-button"
          title={mobileControlsOpen ? 'Close map controls' : 'Open map controls'}
          aria-label={mobileControlsOpen ? 'Close map controls' : 'Open map controls'}
          aria-expanded={mobileControlsOpen}
          aria-controls="map-control-items"
          onClick={() => {
            setMobileControlsOpen((open) => !open);
            setControlPanel(null);
          }}
        >
          <span aria-hidden="true" className="baharoute-hamburger-icon">
            <span />
            <span />
            <span />
          </span>
        </button>
        <div id="map-control-items" className="baharoute-control-items">
          <div className="baharoute-control-card baharoute-control-card--single baharoute-recenter-card"><RecenterControl onRecenter={handleRecenter} /></div>


          <ZoomControls onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} />
          <div className="baharoute-control-card baharoute-control-card--single"><ViewModeControl is3D={is3D || driving} onToggle={handleViewModeToggle} /></div>
          <div className="baharoute-control-card baharoute-control-card--rotate"><RotateControl bearing={bearing} onRotate={handleRotateBy} onResetNorth={handleResetNorth} /></div>
          <div className="baharoute-control-card baharoute-control-card--single"><LocationControl onActivate={handleLocationArrow} /></div>
          <CamButton
            open={controlPanel === 'cameras'}
            onOpenChange={(open) => setControlPanel(open ? 'cameras' : null)}
            loadCameras={async (signal) => {
              const snapshot = loadCameraSnapshot
                ? await loadCameraSnapshot(signal)
                : await fetchWindyCameras(fetch, signal);
              return snapshot.cameras;
            }}
            onSelectCamera={handleSelectCameraFromList}
          />
          <LayersButton
            open={controlPanel === 'layers'}
            onOpenChange={(open) => setControlPanel(open ? 'layers' : null)}
          >
          <LayerControl
            layers={layers}
            groups={layerGroups}
            onToggle={handleLayerToggle}
            statusById={
              floodRiskVisible && riskStatus?.dataUnavailable
                ? { barangayFloodRisk: 'âš  unavailable' }
                : undefined
            }
            hint={
              !floodRiskVisible &&
              !historicalVisible &&
              !layerVisible.communityReports &&
              !layerVisible.officialClosures
                ? 'Select a layer to explore flood conditions.'
                : undefined
            }
          />
          <MapContextControl value={mapContext} onChange={handleMapContextChange} />
          </LayersButton>
        </div>
      </div>

      {/* Legends appear ONLY for enabled layers (Phase 4 cleanup). The legend
          is hidden entirely when neither Flood Risk nor Historical is on, and
          each section is gated by its own layer. Still yields to an open
          details panel and is hidden while driving/error. */}
      {phase !== 'error' &&
        !driving &&
        !popupOpen &&
        /* Suppress the bottom-left legend only when a TALL left-column panel
           (Historical Explore / Flood Insights) is ACTUALLY rendered in that
           column â€” which is what caused the "orphan card under Historical
           Explore" overlap. Those hosts render only in the ready phase; the
           compact Search/Compare trip panels sit at the top and never reach the
           legend, so the legend stays visible with them. */
        !(
          phase === 'ready' &&
          (primaryLeftPanel === 'explore' || primaryLeftPanel === 'insights')
        ) &&
        (floodRiskVisible || historicalVisible) && (
          <MapLegend
            defaultExpanded={historicalVisible}
            showCurrent={floodRiskVisible}
            showHistorical={historicalVisible}
          />
        )}

      {/* Select-on-map mode banner: explains the temporary selection state and
          offers Cancel. While active, the next NCR map tap sets the point and
          selection takes click priority over barangay/flood clicks. */}
      {phase !== 'error' && !driving && pickTarget && (
        <div
          className="baharoute-select-banner"
          role="status"
          data-testid="select-mode-banner"
        >
          <span>
            {pickTarget === 'origin'
              ? 'Tap the map to choose your starting point'
              : 'Tap the map to choose your destination'}
          </span>
          <button
            type="button"
            className="baharoute-select-banner__cancel baharoute-focus-ring"
            onClick={() => handlePickOnMap(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Report-flooding pick mode: the next NCR tap drops an UNVERIFIED
          community report. Clearly labeled unverified so it never reads as
          official/confirmed. */}
      {phase !== 'error' && !driving && reportPickActive && (
        <div
          className="baharoute-select-banner"
          role="status"
          data-testid="report-mode-banner"
        >
          <span>Tap the map to add an unverified flood report</span>
          <button
            type="button"
            className="baharoute-select-banner__cancel baharoute-focus-ring"
            onClick={handleReportFloodingToggle}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Community Report V2 form: shown after a report-mode tap (new report)
          or when editing an existing report's conditions. Collects structured
          severity/depth/passability + an optional note. Clearly unverified. */}
      {phase !== 'error' && !driving && (pendingReportPoint || conditionsEditId) && (
        <div className="baharoute-report-form-host" data-testid="report-form-host">
          <ReportForm
            onSubmit={conditionsEditId ? handleConditionsUpdate : handleReportFormSubmit}
            onCancel={() => {
              setPendingReportPoint(null);
              setConditionsEditId(null);
            }}
          />
        </div>
      )}

      {/* Segmented mode switcher (Route / Community / Historical). Keeps the
          three interaction surfaces mutually exclusive so they never crowd the
          screen together. Hidden while driving/error. */}
      {phase !== 'error' && !driving && (
        <div className="baharoute-mode-switcher-host" data-testid="mode-switcher-host">
          <MapModeSwitcher value={mapMode} onChange={handleMapModeChange} />
        </div>
      )}

      {/* Trip flow panels: SEARCH then COMPARE. The first interaction is
          planning a trip â€” never Driver Mode. Hidden while driving/error.
          When a barangay's Flood Insights is open, it temporarily REPLACES the
          resumable search panel so two large left-side panels never stack
          (they restore when Insights closes). */}
      {primaryLeftPanel === 'search' && mapMode === 'route' && (
        <div className="baharoute-trip-host baharoute-trip-host--search" data-testid="trip-host">
          <RouteSearchPanel
            key={routePanelSession}
            origin={tripOrigin}
            destination={tripDestination}
            onOriginChange={handleOriginChange}
            onDestinationChange={handleDestinationChange}
            onUseCurrentLocation={handleUseCurrentLocation}
            onPickOnMap={handlePickOnMap}
            pickTarget={pickTarget}
            onFindRoutes={handleFindRoutes}
            autoFindOnMount={false}
            busy={findingRoutes}
            locationStatus={locationStatus}
          />
          {tripNotice && (
            <p className="baharoute-trip-panel__notice" role="status" data-testid="trip-notice">
              {tripNotice}
            </p>
          )}
        </div>
      )}

      {/* Privacy-first location consent. Rendered only while open; the browser
          geolocation prompt is reached only after the user presses Allow. */}
      <LocationConsentDialog
        open={consentOpen}
        onAllow={handleConsentAllow}
        onDismiss={handleConsentDismiss}
      />
      {primaryLeftPanel === 'compare' && (
        <div className="baharoute-trip-host" data-testid="trip-host" data-minimized={routePanelMinimized ? 'true' : undefined}>
          <button
            type="button"
            className="baharoute-route-sheet-toggle baharoute-focus-ring"
            aria-expanded={!routePanelMinimized}
            aria-controls="route-comparison-details"
            onClick={() => setRoutePanelMinimized(value => !value)}
          >
            {routePanelMinimized ? 'View routes' : 'Minimize routes'}
          </button>
          {routePanelMinimized && (
            <div className="baharoute-route-summary" data-testid="route-summary">
              <strong>Point A · {tripOrigin?.label}</strong>
              <span>Point B · {tripDestination?.label}</span>
              <span>{findingRoutes ? 'Finding routes…' : selectedRouteOption
                ? `${formatDuration(selectedRouteOption.candidate.durationS)} · ${formatDistance(selectedRouteOption.candidate.distanceM)}`
                : 'No routes available. View routes to change your trip.'}</span>
            </div>
          )}
          <div id="route-comparison-details" className="baharoute-route-comparison-details">
          <RouteComparePanel
            options={routeOptions}
            selectedId={selectedRouteId}
            onSelect={handleSelectRoute}
            onStart={handleStartRoute}
            onBack={handleTripBack}
            mode={travelMode}
            onModeChange={handleModeChange}
            preference={routePreference}
            onPreferenceChange={handlePreferenceChange}
            finding={findingRoutes}
            freshnessLabel={
              riskStatus ? formatRelativeTime(riskStatus.lastUpdated) : null
            }
          />
          </div>
        </div>
      )}

      {/* Compact live-data status pill. Shown ONLY when the Flood Risk layer is
          enabled â€” the pill reports the live rainfall source the user is
          actually viewing. Suppressed when Flood Risk is OFF (Phase 4 cleanup).
          Hidden while driving/error. */}
      {phase === 'ready' &&
        !driving &&
        floodRiskVisible &&
        riskStatus &&
        popup?.kind !== 'barangay' && (
          <LiveStatusPill
            freshness={riskStatus.freshness}
            lastUpdated={riskStatus.lastUpdated}
          />
        )}

      {/* Historical "explore" panel (filters + NCR/city summaries). Shown only
          when the Historical layer is enabled and no barangay is selected â€”
          per-barangay detail lives in Flood Insights. Independent of current
          risk. */}
      {phase === 'ready' && primaryLeftPanel === 'explore' && (
        <div className="baharoute-explore-host" data-testid="explore-host">
          <HistoricalExplorePanel
            filter={historicalFilter}
            onFilterChange={setHistoricalFilter}
            onOpenBarangay={selectHistoricalBarangay}
          />
        </div>
      )}

      {/* Historical hover tooltip: barangay name / city / historical class.
          Shown only while the Historical layer is visible and a barangay is
          hovered; stays anchored while hovered and opens historical details when clicked. */}
      {phase === 'ready' && !driving && historicalVisible && historicalHover && (
        <button
          className="baharoute-hist-tooltip baharoute-focus-ring"
          data-testid="historical-hover-tooltip"
          type="button"
          onMouseEnter={keepHistoricalHover}
          onMouseLeave={dismissHistoricalHover}
          onFocus={keepHistoricalHover}
          onBlur={dismissHistoricalHover}
          onClick={() => selectHistoricalBarangay(historicalHover.psgc)}
          aria-label={`View historical details for ${historicalHover.name}`}
          style={{
            left: historicalHover.point.x,
            top: historicalHover.point.y,
          }}
        >
          <span className="baharoute-hist-tooltip__name">{historicalHover.name}</span>
          <span className="baharoute-hist-tooltip__city">{historicalHover.city}</span>
          <span
            className="baharoute-hist-tooltip__class"
            style={{ color: HISTORICAL_RISK_COLORS[historicalHover.cls].hex }}
          >
            Historical Flood Susceptibility: {historicalHover.cls}
          </span>
          <span className="baharoute-hist-tooltip__action">View historical details →</span>
        </button>
      )}

      {/* City hover tooltip (city name + barangay count). Lightweight; shown
          only in City view while the Historical layer is visible. */}
      {phase === 'ready' &&
        !driving &&
        historicalVisible &&
        cityHover &&
        !historicalHover && (
          <button
            className="baharoute-hist-tooltip baharoute-focus-ring"
            data-testid="city-hover-tooltip"
            type="button"
            onMouseEnter={keepHistoricalHover}
            onMouseLeave={dismissHistoricalHover}
            onFocus={keepHistoricalHover}
            onBlur={dismissHistoricalHover}
            onClick={() => handleCityMapSelect(cityHover.cityPsgc)}
            aria-label={`Explore historical risk in ${cityHover.cityName}`}
            style={{ left: cityHover.point.x, top: cityHover.point.y }}
          >
            <span className="baharoute-hist-tooltip__name">{cityHover.cityName}</span>
            <span className="baharoute-hist-tooltip__city">
              {cityHover.barangayCount} barangays
            </span>
            <span style={{ color: HISTORICAL_RISK_COLORS[cityHover.riskClass].hex }}>
              {cityHover.riskClass} historical risk (dominant city class)
            </span>
            <span className="baharoute-hist-tooltip__action">Explore city →</span>
          </button>
        )}

      {/* When BOTH Flood Risk and Historical are on and live current-risk data
          is unavailable, clarify the historical colors are NOT current. Not
          shown when Flood Risk is OFF (no current-risk warnings in that mode). */}
      {phase === 'ready' &&
        !driving &&
        floodRiskVisible &&
        historicalVisible &&
        riskStatus?.dataUnavailable && (
          <div
            className="baharoute-history-context"
            data-testid="history-context-message"
            role="status"
          >
            Current risk unavailable â€” historical susceptibility shown for
            reference.
          </div>
        )}

      {/* Barangay selection opens the unified Flood Insights panel (its own
          header/close/tabs/mobile bottom-sheet). Current + Historical are
          grouped here but the datasets stay separate. */}
      {primaryLeftPanel === 'insights' && popup?.kind === 'barangay' && (
        <div className="baharoute-insights-host" data-testid="insights-host">
          <FloodInsights
            barangayName={
              barangayPanelProps?.barangayName ??
              historicalRiskByBarangay.get(popup.psgc)?.name ??
              'Barangay'
            }
            cityName={
              barangayPanelProps?.cityName ??
              historicalRiskByBarangay.get(popup.psgc)?.city ??
              ''
            }
            tab={insightsTab}
            onTabChange={setInsightsTab}
            current={barangayPanelProps}
            historical={historicalRiskByBarangay.get(popup.psgc) ?? null}
            timelineStep={timelineStep}
            onTimelineStep={handleTimelineStep}
            onClose={() => setPopup(null)}
            sheetState={insightsSheet}
            onSheetStateChange={setInsightsSheet}
          />
        </div>
      )}

      {/* Recoverable "Route ready" chip: shown when a route comparison exists
          but another panel (Insights / Explore) is the primary left panel, so
          the route is never lost or stacked underneath. Tapping it swaps the
          Route Compare panel back in. Never calls a route "safe". */}
      {showRouteReadyChip && selectedRouteOption && (
        <button
          type="button"
          className="baharoute-route-chip baharoute-focus-ring"
          data-testid="route-ready-chip"
          onClick={handleViewRoute}
        >
          <span className="baharoute-route-chip__title">Route ready</span>
          <span className="baharoute-route-chip__meta">
            {formatDuration(selectedRouteOption.candidate.durationS)} Â·{' '}
            {formatDistance(selectedRouteOption.candidate.distanceM)}
          </span>
          <span className="baharoute-route-chip__cta" aria-hidden="true">
            View route
          </span>
        </button>
      )}

      {/* HISTORICAL Flood Evidence panel (DEMO / RESEARCH USE ONLY). Context
          only; selecting an item opens its historical popup and (for EXACT/HIGH
          items) focuses the map. Never affects current risk/closures/routing. */}
      {showHistoricalEvidence && (
        <div className="baharoute-historical-host" data-testid="historical-evidence-host">
          <HistoricalEvidencePanel
            evidence={historicalFloodEvidence}
            onAgentRunChange={setHistoricalAgentRan}
            onClose={() => {
              setPopup((current) => current?.kind === 'historical' ? null : current);
              setShowHistoricalEvidence(false);
              setHistoricalAgentRan(false);
              setMapMode('route');
            }}
            onFilteredChange={(filtered) => {
              const liveMap = managerRef.current?.getMap?.() ?? null;
              if (liveMap) {
                updateHistoricalEvidenceSource(
                  liveMap as unknown as HistoricalSourceUpdateMap,
                  filtered,
                );
              }
            }}
            selectedId={popup?.kind === 'historical' ? popup.evidenceId : null}
            onSelect={selectHistoricalEvidence}
          />
        </div>
      )}

      {/* Report / susceptibility popups keep the compact floating card host.
          Mutually exclusive with the report-compose form (defense-in-depth for
          #1/#6): never render a selected-report popup while composing/editing a
          report, so lifecycle actions can't appear during new-report creation. */}
      {popup && popup.kind !== 'barangay' && !pendingReportPoint && !conditionsEditId && (
        <div className="baharoute-popup-host" data-testid="map-popup-host">
          <button
            type="button"
            className="baharoute-popup-close baharoute-icon-button baharoute-focus-ring"
            aria-label="Close popup"
            onClick={() => setPopup(null)}
          >
            <CloseIcon />
          </button>
          {popup.kind === 'report' ? (
            <ReportPopup {...popup.props} />
          ) : popup.kind === 'historical' ? (
            <HistoricalEvidencePopup {...popup.props} />
          ) : (
            <FloodPopup {...popup.props} />
          )}
        </div>
      )}
    </div>
  );
}

export default MapView;
