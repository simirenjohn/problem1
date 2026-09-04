import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  LayersControl,
  ScaleControl,
  useMap,
  useMapEvents,
  Polyline,
  Polygon as LPolygon,
  CircleMarker,
  Tooltip,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  formatArea,
  formatDistance,
  lineDistanceMeters,
  polygonAreaSqMeters,
} from "@/lib/measure";
import type { CoordPoint, Measurement } from "@/lib/projects";

export type MeasureMode = "none" | "distance" | "area";

type Props = {
  parcels: FeatureCollection<Polygon>;
  showParcels: boolean;
  selectedId: string | null;
  onSelect: (parcelNumber: string) => void;
  flyTo: { lat: number; lng: number; zoom?: number } | null;
  measureMode: MeasureMode;
  measurePoints: Array<[number, number]>;
  onMeasurePoint: (pt: [number, number]) => void;
  onMeasureFinish: () => void;
  gpsPosition: { lat: number; lng: number; accuracy: number } | null;
  pinnedPoint: { lat: number; lng: number; label?: string } | null;
  coordPoints?: CoordPoint[];
  coordShape?: "none" | "line" | "polygon";
  savedMeasurements?: Measurement[];
  fitBounds?: Array<[number, number]> | null;
};

const SIANA_CENTER: [number, number] = [-1.552, 35.305];

function FlyHandler({ target }: { target: Props["flyTo"] }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], target.zoom ?? 21, { duration: 0.8 });
  }, [target, map]);
  return null;
}

function FitHandler({ bounds }: { bounds: Array<[number, number]> | null | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (bounds && bounds.length >= 2) {
      map.fitBounds(bounds as L.LatLngBoundsExpression, { padding: [40, 40] });
    } else if (bounds && bounds.length === 1) {
      map.flyTo(bounds[0], 21, { duration: 0.6 });
    }
  }, [bounds, map]);
  return null;
}

function GpsHandler({ position }: { position: Props["gpsPosition"] }) {
  const map = useMap();
  const didCenter = useRef(false);
  useEffect(() => {
    // Only center on the very first fix; afterwards the user stays in control
    // of pan/zoom so they can zoom out and see other points.
    if (position && !didCenter.current) {
      didCenter.current = true;
      map.flyTo([position.lat, position.lng], 20, { duration: 0.8 });
    }
  }, [position, map]);
  return null;
}


function MeasureInteractionLayer({
  mode,
  onPoint,
  onFinish,
  onHover,
}: {
  mode: MeasureMode;
  onPoint: (pt: [number, number]) => void;
  onFinish: () => void;
  onHover: (pt: [number, number] | null) => void;
}) {
  useMapEvents({
    click(e) {
      if (mode === "none") return;
      onPoint([e.latlng.lat, e.latlng.lng]);
    },
    mousemove(e) {
      if (mode === "none") return;
      onHover([e.latlng.lat, e.latlng.lng]);
    },
    mouseout() {
      onHover(null);
    },
    dblclick() {
      if (mode !== "none") onFinish();
    },
  });
  return null;
}

export default function MapView({
  parcels,
  showParcels,
  selectedId,
  onSelect,
  flyTo,
  measureMode,
  measurePoints,
  onMeasurePoint,
  onMeasureFinish,
  gpsPosition,
  pinnedPoint,
  coordPoints = [],
  coordShape = "none",
  savedMeasurements = [],
  fitBounds = null,
}: Props) {
  const geoRef = useRef<L.GeoJSON | null>(null);
  const [hoverPoint, setHoverPoint] = useState<[number, number] | null>(null);

  // Re-render parcels layer when selection or visibility changes by re-keying
  const geoKey = useMemo(
    () => `${selectedId ?? ""}-${showParcels ? "1" : "0"}`,
    [selectedId, showParcels],
  );

  const measureLine = measureMode === "distance" ? measurePoints : [];
  const measurePoly = measureMode === "area" ? measurePoints : [];

  const distance =
    measureMode === "distance" && measurePoints.length >= 2
      ? lineDistanceMeters(measurePoints)
      : 0;
  const area =
    measureMode === "area" && measurePoints.length >= 3
      ? polygonAreaSqMeters(measurePoints)
      : 0;

  // Rubber-band preview from last vertex to hover
  const rubberLine: Array<[number, number]> =
    measureMode !== "none" && measurePoints.length > 0 && hoverPoint
      ? [measurePoints[measurePoints.length - 1], hoverPoint]
      : [];
  const rubberClose: Array<[number, number]> =
    measureMode === "area" && measurePoints.length >= 2 && hoverPoint
      ? [hoverPoint, measurePoints[0]]
      : [];

  const liveDistance =
    measureMode === "distance" && hoverPoint && measurePoints.length > 0
      ? lineDistanceMeters([...measurePoints, hoverPoint])
      : distance;
  const liveArea =
    measureMode === "area" && hoverPoint && measurePoints.length >= 2
      ? polygonAreaSqMeters([...measurePoints, hoverPoint])
      : area;

  return (
    <MapContainer
      center={SIANA_CENTER}
      zoom={15}
      maxZoom={22}
      doubleClickZoom={measureMode === "none"}
      className="h-full w-full"
      style={{ background: "#0a0a0a" }}
    >
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Google Satellite (hybrid)">
          <TileLayer
            attribution="&copy; Google"
            url="https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
            subdomains={["0", "1", "2", "3"]}
            maxZoom={22}
            maxNativeZoom={21}
            keepBuffer={4}
            updateWhenIdle={false}
            updateWhenZooming={false}
            crossOrigin="anonymous"
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Google Satellite">
          <TileLayer
            attribution="&copy; Google"
            url="https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
            subdomains={["0", "1", "2", "3"]}
            maxZoom={22}
            maxNativeZoom={21}
            keepBuffer={4}
            updateWhenIdle={false}
            updateWhenZooming={false}
            crossOrigin="anonymous"
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Esri World Imagery">
          <TileLayer
            attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxZoom={22}
            maxNativeZoom={18}
            keepBuffer={4}
            updateWhenIdle={false}
            updateWhenZooming={false}
            crossOrigin="anonymous"
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="OpenStreetMap">
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={22}
            maxNativeZoom={19}
            keepBuffer={4}
            updateWhenIdle={false}
            updateWhenZooming={false}
            crossOrigin="anonymous"
          />
        </LayersControl.BaseLayer>
        <LayersControl.Overlay name="Esri reference labels">
          <TileLayer
            attribution="Esri Reference"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            maxZoom={22}
            maxNativeZoom={16}
            keepBuffer={4}
            updateWhenIdle={false}
            updateWhenZooming={false}
            crossOrigin="anonymous"
          />
        </LayersControl.Overlay>
      </LayersControl>

      <ScaleControl position="bottomleft" />

      {showParcels && (
        <GeoJSON
          key={geoKey}
          ref={(r) => {
            geoRef.current = r;
          }}
          data={parcels as FeatureCollection}
          style={(feature) => {
            const pn = feature?.properties?.parcel_number as string | undefined;
            const isSelected = pn === selectedId;
            return {
              color: isSelected ? "#fbbf24" : "#22d3ee",
              weight: isSelected ? 3 : 1.5,
              fillColor: isSelected ? "#fbbf24" : "#22d3ee",
              fillOpacity: isSelected ? 0.25 : 0.1,
            };
          }}
          onEachFeature={(feature, layer) => {
            const pn = feature.properties?.parcel_number;
            if (pn) {
              layer.bindTooltip(String(pn), {
                permanent: false,
                direction: "center",
                className: "parcel-tooltip",
              });
            }
            layer.on({
              click: () => {
                if (measureMode !== "none") return;
                if (pn) onSelect(String(pn));
              },
            });
          }}
        />
      )}

      <MeasureInteractionLayer
        mode={measureMode}
        onPoint={onMeasurePoint}
        onFinish={onMeasureFinish}
        onHover={setHoverPoint}
      />

      {rubberLine.length === 2 && (
        <Polyline
          positions={rubberLine}
          pathOptions={{ color: "#fbbf24", weight: 2, dashArray: "6 6", opacity: 0.9 }}
        />
      )}
      {rubberClose.length === 2 && (
        <Polyline
          positions={rubberClose}
          pathOptions={{ color: "#fbbf24", weight: 2, dashArray: "6 6", opacity: 0.7 }}
        />
      )}
      {hoverPoint && measureMode !== "none" && measurePoints.length > 0 && (
        <CircleMarker
          center={hoverPoint}
          radius={0.1}
          pathOptions={{ opacity: 0, fillOpacity: 0 }}
        >
          <Tooltip permanent direction="right" offset={[10, 0]} className="measure-tip">
            {measureMode === "distance"
              ? formatDistance(liveDistance)
              : formatArea(liveArea)}
          </Tooltip>
        </CircleMarker>
      )}

      {measureLine.length >= 1 && (
        <>
          <Polyline positions={measureLine} pathOptions={{ color: "#f97316", weight: 3 }} />
          {measureLine.map((pt, i) => (
            <CircleMarker
              key={i}
              center={pt}
              radius={4}
              pathOptions={{ color: "#f97316", fillColor: "#fff", fillOpacity: 1 }}
            />
          ))}
          {distance > 0 && (
            <CircleMarker
              center={measureLine[measureLine.length - 1]}
              radius={0.1}
              pathOptions={{ opacity: 0, fillOpacity: 0 }}
            >
              <Tooltip permanent direction="top" offset={[0, -8]}>
                {formatDistance(distance)}
              </Tooltip>
            </CircleMarker>
          )}
        </>
      )}

      {measurePoly.length >= 2 && (
        <>
          <LPolygon
            positions={measurePoly}
            pathOptions={{
              color: "#f97316",
              weight: 2,
              fillColor: "#f97316",
              fillOpacity: 0.15,
            }}
          />
          {measurePoly.map((pt, i) => (
            <CircleMarker
              key={i}
              center={pt}
              radius={4}
              pathOptions={{ color: "#f97316", fillColor: "#fff", fillOpacity: 1 }}
            />
          ))}
          {area > 0 && (
            <CircleMarker
              center={measurePoly[0]}
              radius={0.1}
              pathOptions={{ opacity: 0, fillOpacity: 0 }}
            >
              <Tooltip permanent direction="top" offset={[0, -8]}>
                {formatArea(area)}
              </Tooltip>
            </CircleMarker>
          )}
        </>
      )}

      {gpsPosition && (
        <>
          <CircleMarker
            center={[gpsPosition.lat, gpsPosition.lng]}
            radius={7}
            pathOptions={{
              color: "#3b82f6",
              weight: 2,
              fillColor: "#3b82f6",
              fillOpacity: 0.9,
            }}
          >
            <Tooltip>Your location (±{gpsPosition.accuracy.toFixed(0)} m)</Tooltip>
          </CircleMarker>
        </>
      )}

      {pinnedPoint && (
        <CircleMarker
          center={[pinnedPoint.lat, pinnedPoint.lng]}
          radius={8}
          pathOptions={{
            color: "#a3e635",
            weight: 2,
            fillColor: "#a3e635",
            fillOpacity: 0.9,
          }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]}>
            {pinnedPoint.label ??
              `${pinnedPoint.lat.toFixed(6)}, ${pinnedPoint.lng.toFixed(6)}`}
          </Tooltip>
        </CircleMarker>
      )}

      {/* Multi-point coordinate pins from current project */}
      {coordPoints.map((p, i) => (
        <CircleMarker
          key={p.id}
          center={[p.lat, p.lng]}
          radius={7}
          pathOptions={{
            color: "#22d3ee",
            weight: 2,
            fillColor: "#0ea5e9",
            fillOpacity: 0.95,
          }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]} className="coord-tip">
            {p.label || `P${i + 1}`}
          </Tooltip>
        </CircleMarker>
      ))}
      {coordShape === "line" && coordPoints.length >= 2 && (
        <Polyline
          positions={coordPoints.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: "#0ea5e9", weight: 3 }}
        />
      )}
      {coordShape === "polygon" && coordPoints.length >= 3 && (
        <LPolygon
          positions={coordPoints.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: "#0ea5e9",
            weight: 2,
            fillColor: "#0ea5e9",
            fillOpacity: 0.2,
          }}
        />
      )}

      {/* Saved measurements from project */}
      {savedMeasurements.map((m) => {
        const pts = m.points as L.LatLngExpression[];
        return m.type === "distance" ? (
          <Polyline
            key={m.id}
            positions={pts}
            pathOptions={{ color: "#f59e0b", weight: 2, dashArray: "2 4" }}
          />
        ) : (
          <LPolygon
            key={m.id}
            positions={pts}
            pathOptions={{
              color: "#f59e0b",
              weight: 2,
              fillColor: "#f59e0b",
              fillOpacity: 0.1,
              dashArray: "2 4",
            }}
          />
        );
      })}

      <FlyHandler target={flyTo} />
      <FitHandler bounds={fitBounds} />
      <GpsHandler position={gpsPosition} />
    </MapContainer>
  );
}

// Helper to find feature by parcel_number
export function findParcel(
  data: FeatureCollection<Polygon>,
  parcelNumber: string,
): Feature<Polygon> | null {
  return (
    (data.features.find(
      (f) => f.properties?.parcel_number === parcelNumber,
    ) as Feature<Polygon> | undefined) ?? null
  );
}

export function featureCenter(f: Feature<Polygon>): { lat: number; lng: number } {
  const ring = f.geometry.coordinates[0];
  let x = 0,
    y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  const n = ring.length;
  return { lat: y / n, lng: x / n };
}