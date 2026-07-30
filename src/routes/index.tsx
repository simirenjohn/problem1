import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  Search,
  Ruler,
  Hexagon,
  Layers,
  X,
  Download,
  MapPin,
  Info,
  Navigation,
  Plus,
  Trash2,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Save,
  Upload,
  Spline,
  Shapes,
  Maximize2,
  Undo2,
  FileUp,
  Image as ImageIcon,
  Loader2,
  Globe2,
} from "lucide-react";
import parcelsData from "@/data/parcels.geojson?raw";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  geojsonPolygonArea,
  geojsonPolygonPerimeter,
  formatArea,
  formatDistance,
  lineDistanceMeters,
  polygonAreaSqMeters,
} from "@/lib/measure";
import {
  downloadBlob,
  parcelToGeoJSON,
  parcelToKML,
} from "@/lib/parcel-export";
import {
  parseDecimal,
  utmToLatLng,
  ARC1960_TO_WGS84_EPSG,
  ARC1960_TO_WGS84_CONTROLLER,
  type SevenParam,
} from "@/lib/coords";
import { importGisFile } from "@/lib/import-gis";
import { extractCoordPointsFromText, runOcr } from "@/lib/ocr";
import {
  type Project,
  type CoordPoint,
  type DatumPreset,
  createProject,
  ensureDefaultProject,
  exportProject,
  newMeasurementId,
  newPointId,
  parseImportedProject,
  saveProjects,
  setActiveProjectId,
} from "@/lib/projects";

const MapView = lazy(() => import("@/components/map/MapView"));
const GpsCompass = lazy(() => import("@/components/gps/GpsCompass"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RTK mobile app" },
      {
        name: "description",
        content:
          "Rtk mobile app tjat enable precision mapping and survey including beacon identifier",
      },
    ],
  }),
  component: Index,
});

type MeasureMode = "none" | "distance" | "area";
type SectionId =
  | "projects"
  | "search"
  | "layers"
  | "coords"
  | "datum"
  | "import"
  | "measure"
  | "info";

function Index() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const parcels = useMemo<FeatureCollection<Polygon>>(
    () => JSON.parse(parcelsData) as FeatureCollection<Polygon>,
    [],
  );
  const hasParcels = parcels.features.length > 0;

  // --- Projects ---
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const gisInputRef = useRef<HTMLInputElement | null>(null);
  const ocrInputRef = useRef<HTMLInputElement | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  useEffect(() => {
    const { projects: ps, activeId: a } = ensureDefaultProject();
    setProjects(ps);
    setActiveId(a);
  }, []);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId],
  );

  const updateActive = (mut: (p: Project) => Project) => {
    setProjects((prev) => {
      const next = prev.map((p) =>
        p.id === activeId ? { ...mut(p), updatedAt: Date.now() } : p,
      );
      saveProjects(next);
      return next;
    });
  };

  const switchProject = (id: string) => {
    setActiveId(id);
    setActiveProjectId(id);
  };

  const handleNewProject = () => {
    const name = window.prompt("Project name?", `Project ${projects.length + 1}`);
    if (name === null) return;
    const p = createProject(name);
    const next = [...projects, p];
    setProjects(next);
    saveProjects(next);
    switchProject(p.id);
  };

  const handleRenameProject = () => {
    if (!activeProject) return;
    const name = window.prompt("Rename project", activeProject.name);
    if (!name) return;
    updateActive((p) => ({ ...p, name }));
  };

  const handleDeleteProject = () => {
    if (!activeProject) return;
    if (!window.confirm(`Delete project "${activeProject.name}"?`)) return;
    const next = projects.filter((p) => p.id !== activeProject.id);
    const fallback = next[0] ?? createProject("My first project");
    const finalList = next.length ? next : [fallback];
    setProjects(finalList);
    saveProjects(finalList);
    switchProject(fallback.id);
  };

  const handleExportProject = () => {
    if (!activeProject) return;
    downloadBlob(
      `${activeProject.name.replace(/\s+/g, "_")}.json`,
      "application/json",
      exportProject(activeProject),
    );
  };

  const handleImportProject = async (file: File) => {
    const text = await file.text();
    try {
      const p = parseImportedProject(text);
      const next = [...projects, p];
      setProjects(next);
      saveProjects(next);
      switchProject(p.id);
    } catch (e) {
      alert("Could not import project: " + (e as Error).message);
    }
  };

  // --- Map state ---
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    projects: true,
    search: false,
    layers: false,
    coords: true,
    datum: false,
    import: false,
    measure: false,
    info: false,
  });
  const toggleSection = (id: SectionId) =>
    setOpenSections((s) => ({ ...s, [id]: !s[id] }));

  const [showParcels, setShowParcels] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number; zoom?: number } | null>(
    null,
  );
  const [fitBounds, setFitBounds] = useState<Array<[number, number]> | null>(null);

  // --- Measure ---
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none");
  const [measurePoints, setMeasurePoints] = useState<Array<[number, number]>>([]);

  const finishMeasure = () => {
    if (measureMode === "none") return;
    const min = measureMode === "distance" ? 2 : 3;
    if (measurePoints.length >= min && activeProject) {
      updateActive((p) => ({
        ...p,
        measurements: [
          ...p.measurements,
          { id: newMeasurementId(), type: measureMode, points: measurePoints },
        ],
      }));
    }
    setMeasureMode("none");
    setMeasurePoints([]);
  };

  const cancelMeasure = () => {
    setMeasureMode("none");
    setMeasurePoints([]);
  };

  useEffect(() => {
    if (measureMode === "none") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") finishMeasure();
      else if (e.key === "Escape") cancelMeasure();
      else if (e.key === "Backspace") setMeasurePoints((pts) => pts.slice(0, -1));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureMode, measurePoints]);

  // --- GPS (driven by the compass widget) ---
  const [gpsPosition, setGpsPosition] = useState<{
    lat: number;
    lng: number;
    accuracy: number;
  } | null>(null);

  // --- UTM coordinate entry (Arc 1960, Southern hemisphere — Kenya) ---
  const [eastingInput, setEastingInput] = useState("");
  const [northingInput, setNorthingInput] = useState("");
  const [utmZone, setUtmZone] = useState("36");
  const [labelInput, setLabelInput] = useState("");
  const [coordError, setCoordError] = useState<string | null>(null);
  const [coordShape, setCoordShape] = useState<"none" | "line" | "polygon">("none");

  // Active Arc1960 -> WGS84 transform (per project, falls back to EPSG default).
  const datumParams: SevenParam =
    activeProject?.datumParams?.values ?? ARC1960_TO_WGS84_EPSG;
  const datumPreset: DatumPreset = activeProject?.datumParams?.preset ?? "epsg";

  const setDatumPreset = (preset: DatumPreset) => {
    let values: SevenParam;
    if (preset === "epsg") values = ARC1960_TO_WGS84_EPSG;
    else if (preset === "controller") values = ARC1960_TO_WGS84_CONTROLLER;
    else values = { ...datumParams };
    updateActive((p) => ({ ...p, datumParams: { preset, values } }));
  };

  const setDatumValue = (key: keyof SevenParam, v: string) => {
    const n = parseDecimal(v);
    if (n === null) return;
    updateActive((p) => ({
      ...p,
      datumParams: {
        preset: "custom",
        values: { ...(p.datumParams?.values ?? datumParams), [key]: n },
      },
    }));
  };

  const addCoordPoint = () => {
    setCoordError(null);
    const e = parseDecimal(eastingInput);
    const n = parseDecimal(northingInput);
    const z = parseInt(utmZone, 10);
    if (e === null || n === null || !z || z < 1 || z > 60) {
      setCoordError("Enter valid easting, northing and zone (1–60).");
      return;
    }
    if (e < 100000 || e > 900000) {
      setCoordError("Easting out of range (expect ~160,000–840,000 m).");
      return;
    }
    const r = utmToLatLng(e, n, z, "S", "ARC1960", datumParams);
    const label =
      labelInput.trim() ||
      `P${(activeProject?.points.length ?? 0) + 1}`;
    const pt: CoordPoint = { id: newPointId(), label, lat: r.lat, lng: r.lng };
    updateActive((p) => ({ ...p, points: [...p.points, pt] }));
    setFlyTo({ lat: r.lat, lng: r.lng, zoom: 18 });
    setEastingInput("");
    setNorthingInput("");
    setLabelInput("");
  };

  // --- GIS import ---
  const handleGisFile = async (file: File) => {
    if (!activeProject) return;
    setImportBusy(true);
    setImportStatus(`Reading ${file.name}…`);
    try {
      const res = await importGisFile(file);
      const adjPoints = res.points;
      const adjMeasurements = res.measurements;
      updateActive((p) => ({
        ...p,
        points: [...p.points, ...adjPoints],
        measurements: [...p.measurements, ...adjMeasurements],
      }));
      const all = [
        ...adjPoints.map((p) => [p.lat, p.lng] as [number, number]),
        ...adjMeasurements.flatMap((m) => m.points),
      ];
      if (all.length > 0) {
        setFitBounds(all);
        setTimeout(() => setFitBounds(null), 100);
      }
      setImportStatus(
        `Imported ${adjPoints.length} point(s), ${adjMeasurements.length} shape(s).` +
          (res.warnings.length ? " " + res.warnings.join(" ") : ""),
      );
    } catch (e) {
      setImportStatus("Import failed: " + (e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  // --- OCR import ---
  const handleOcrFile = async (file: File) => {
    if (!activeProject) return;
    setImportBusy(true);
    setImportStatus(`Running OCR on ${file.name}…`);
    try {
      const text = await runOcr(file);
      const { points: pts, raw } = extractCoordPointsFromText(text, {
        defaultZone: parseInt(utmZone, 10) || 36,
        defaultHemisphere: "S",
        datum: "ARC1960",
        datumParams,
      });
      if (pts.length === 0) {
        setImportStatus(
          "OCR found no coordinate-like numbers. Try a clearer image.",
        );
        return;
      }
      const adj = pts;
      updateActive((p) => ({ ...p, points: [...p.points, ...adj] }));
      setFitBounds(adj.map((p) => [p.lat, p.lng] as [number, number]));
      setTimeout(() => setFitBounds(null), 100);
      setImportStatus(
        `OCR detected ${adj.length} coordinate(s): ${raw.slice(0, 3).join(" · ")}${
          raw.length > 3 ? "…" : ""
        }`,
      );
    } catch (e) {
      setImportStatus("OCR failed: " + (e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  const removePoint = (id: string) => {
    updateActive((p) => ({ ...p, points: p.points.filter((x) => x.id !== id) }));
  };

  const clearAllPoints = () => {
    if (!activeProject) return;
    if (!window.confirm("Clear all points in this project?")) return;
    updateActive((p) => ({ ...p, points: [] }));
    setCoordShape("none");
  };

  const flyToAllPoints = () => {
    const pts = activeProject?.points ?? [];
    if (pts.length === 0) return;
    setFitBounds(pts.map((p) => [p.lat, p.lng] as [number, number]));
    setTimeout(() => setFitBounds(null), 100);
  };

  const lineDist =
    activeProject && activeProject.points.length >= 2
      ? lineDistanceMeters(activeProject.points.map((p) => [p.lat, p.lng]))
      : 0;
  const polyArea =
    activeProject && activeProject.points.length >= 3
      ? polygonAreaSqMeters(activeProject.points.map((p) => [p.lat, p.lng]))
      : 0;

  // --- Parcel selection ---
  const selected: Feature<Polygon> | null = useMemo(() => {
    if (!selectedId) return null;
    return (
      (parcels.features.find(
        (f) => f.properties?.parcel_number === selectedId,
      ) as Feature<Polygon> | undefined) ?? null
    );
  }, [parcels, selectedId]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return parcels.features
      .filter((f) =>
        String(f.properties?.parcel_number ?? "").toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [parcels, query]);

  const handleSelect = (parcelNumber: string) => {
    setSelectedId(parcelNumber);
    setOpenSections((s) => ({ ...s, info: true }));
    const f = parcels.features.find(
      (x) => x.properties?.parcel_number === parcelNumber,
    ) as Feature<Polygon> | undefined;
    if (f) {
      const ring = f.geometry.coordinates[0];
      let x = 0,
        y = 0;
      for (const [lng, lat] of ring) {
        x += lng;
        y += lat;
      }
      setFlyTo({ lat: y / ring.length, lng: x / ring.length, zoom: 17 });
    }
  };

  const exportGeoJSON = () => {
    if (!selected) return;
    downloadBlob(
      `${selected.properties?.parcel_number ?? "parcel"}.geojson`,
      "application/geo+json",
      parcelToGeoJSON(selected),
    );
  };
  const exportKML = () => {
    if (!selected) return;
    downloadBlob(
      `${selected.properties?.parcel_number ?? "parcel"}.kml`,
      "application/vnd.google-earth.kml+xml",
      parcelToKML(selected),
    );
  };

  const startMeasure = (mode: MeasureMode) => {
    setMeasureMode(mode);
    setMeasurePoints([]);
    setOpenSections((s) => ({ ...s, measure: true }));
  };

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-[oklch(0.14_0.03_260)] text-foreground">
      {/* Sidebar */}
      <aside
        className={`relative z-[1100] flex h-full shrink-0 flex-col border-r border-white/5 bg-gradient-to-b from-[oklch(0.18_0.04_265)] via-[oklch(0.15_0.035_262)] to-[oklch(0.12_0.03_260)] text-slate-100 shadow-2xl transition-[width] duration-200 ${
          sidebarOpen ? "w-[360px]" : "w-14"
        }`}
      >
        {/* Sidebar header */}
        <div className="relative flex h-14 items-center justify-between border-b border-white/5 px-3">
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
          {sidebarOpen ? (
            <div className="flex items-center gap-2.5 pl-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 shadow-lg shadow-cyan-500/30">
                <MapPin className="h-4 w-4 text-white" />
              </div>
              <div className="leading-tight">
                <div className="text-sm font-semibold tracking-tight text-white">Siana RIM</div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Field Surveyor</div>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 shadow-lg shadow-cyan-500/30">
              <MapPin className="h-4 w-4 text-white" />
            </div>
          )}
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </div>

        {sidebarOpen ? (
          <div className="custom-scroll flex-1 space-y-2 overflow-y-auto p-3">
            {/* Projects */}
            <Section
              id="projects"
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              title="Project"
              accent="from-cyan-400 to-blue-500"
              open={openSections.projects}
              onToggle={toggleSection}
            >
              <div className="space-y-2.5">
                <select
                  value={activeId}
                  onChange={(e) => switchProject(e.target.value)}
                  className="h-9 w-full rounded-md border border-white/10 bg-white/5 px-2 text-sm text-white focus:border-cyan-400/60 focus:outline-none"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id} className="bg-slate-800">
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-1.5">
                  <SbBtn onClick={handleNewProject}><Plus className="mr-1 h-3.5 w-3.5" /> New</SbBtn>
                  <SbBtn onClick={handleRenameProject}>Rename</SbBtn>
                  <SbBtn onClick={handleExportProject}><Save className="mr-1 h-3.5 w-3.5" /> Export</SbBtn>
                  <SbBtn onClick={() => importInputRef.current?.click()}><Upload className="mr-1 h-3.5 w-3.5" /> Import</SbBtn>
                  <button
                    onClick={handleDeleteProject}
                    className="col-span-2 flex items-center justify-center rounded-md py-1.5 text-[11px] text-rose-400/80 transition hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete project
                  </button>
                </div>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImportProject(f);
                    e.target.value = "";
                  }}
                />
                {activeProject && (
                  <div className="flex items-center gap-2 rounded-md bg-white/5 px-2 py-1.5 text-[10px] text-slate-400">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_oklch(0.7_0.18_150)]" />
                    {activeProject.points.length} pts · {activeProject.measurements.length} meas · saved {new Date(activeProject.updatedAt).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </Section>

            {/* Search */}
            {hasParcels && (
              <Section
                id="search"
                icon={<Search className="h-3.5 w-3.5" />}
                title="Search parcels"
                accent="from-violet-400 to-fuchsia-500"
                open={openSections.search}
                onToggle={toggleSection}
              >
                <div className="flex gap-2">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g. SIANA/001"
                    className="h-9 border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                  />
                  {query && (
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-slate-400 hover:bg-white/10" onClick={() => setQuery("")}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {query && (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-white/10 bg-black/20">
                    {results.length === 0 ? (
                      <div className="p-3 text-xs text-slate-500">No matches</div>
                    ) : (
                      results.map((f) => {
                        const pn = String(f.properties?.parcel_number);
                        return (
                          <button
                            key={pn}
                            onClick={() => handleSelect(pn)}
                            className="block w-full px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/5"
                          >
                            {pn}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </Section>
            )}

            {/* Layers */}
            <Section
              id="layers"
              icon={<Layers className="h-3.5 w-3.5" />}
              title="Layers"
              accent="from-emerald-400 to-teal-500"
              open={openSections.layers}
              onToggle={toggleSection}
            >
              {hasParcels ? (
                <SbBtn className="w-full justify-start" onClick={() => setShowParcels((s) => !s)}>
                  <Layers className="mr-2 h-3.5 w-3.5" />
                  {showParcels ? "Hide parcels" : "Show parcels"}
                </SbBtn>
              ) : (
                <p className="rounded-md border border-dashed border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-400">
                  No Siana RIM parcels loaded yet. Import a GeoJSON / KML / SHP via the Import section once you have the data.
                </p>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                Use the layers control (top-right of the map) to switch between Google Satellite Hybrid, Google Satellite, Esri imagery, and OSM.
              </p>
            </Section>

            {/* Coordinates — UTM only, Southern hemisphere, Arc 1960 default */}
            <Section
              id="coords"
              icon={<Navigation className="h-3.5 w-3.5" />}
              title="UTM coordinates"
              accent="from-cyan-400 to-sky-500"
              open={openSections.coords}
              onToggle={toggleSection}
            >
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <LabeledInput label="Easting (m)" value={eastingInput} onChange={setEastingInput} placeholder="700000" />
                  <LabeledInput label="Northing (m)" value={northingInput} onChange={setNorthingInput} placeholder="9828000" />
                </div>

                <div>
                  <FieldLabel>Zone (Narok)</FieldLabel>
                  <div className="grid grid-cols-2 gap-1">
                    {(["36", "37"] as const).map((z) => (
                      <button
                        key={z}
                        onClick={() => setUtmZone(z)}
                        className={`rounded-md py-1.5 text-xs font-medium transition ${
                          utmZone === z
                            ? "bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow shadow-cyan-500/30"
                            : "bg-white/5 text-slate-300 hover:bg-white/10"
                        }`}
                      >
                        Zone {z}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-slate-400">
                  Datum: <strong className="text-slate-200">Arc 1960 / Clarke 1880 / UTM {utmZone}S</strong> ·
                  shift preset: <strong className="text-slate-200">{datumPreset === "epsg" ? "EPSG (−157,−2,−299)" : datumPreset === "controller" ? "Controller (+163,+6,+298)" : "Custom"}</strong>
                </p>

                <LabeledInput
                  label="Label (optional)"
                  value={labelInput}
                  onChange={setLabelInput}
                  placeholder="e.g. Corner A, BM-1, North gate"
                  inputMode="text"
                />

                <button
                  onClick={addCoordPoint}
                  className="flex w-full items-center justify-center rounded-md bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-500/25 transition hover:from-cyan-400 hover:to-blue-500"
                >
                  <Plus className="mr-2 h-4 w-4" /> Add point
                </button>
                {coordError && <p className="text-xs text-rose-400">{coordError}</p>}
              </div>

              {/* Points list */}
              {activeProject && activeProject.points.length > 0 && (
                <>
                  <Separator className="my-3 bg-white/10" />
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                      Points · {activeProject.points.length}
                    </h3>
                    <button onClick={clearAllPoints} className="text-[10px] text-slate-500 hover:text-rose-400">Clear</button>
                  </div>
                  <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
                    {activeProject.points.map((p, i) => (
                      <li key={p.id} className="group flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5 text-xs transition hover:border-cyan-400/30 hover:bg-cyan-400/5">
                        <span className="font-mono text-[10px] text-cyan-400/70">{String(i + 1).padStart(2, "0")}</span>
                        <button
                          className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-white"
                          onClick={() => setFlyTo({ lat: p.lat, lng: p.lng, zoom: 18 })}
                          title={`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`}
                        >
                          {p.label}
                        </button>
                        <button className="opacity-0 transition group-hover:opacity-100" onClick={() => removePoint(p.id)} aria-label="Remove">
                          <X className="h-3.5 w-3.5 text-rose-400" />
                        </button>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <ToggleBtn active={coordShape === "line"} onClick={() => setCoordShape((s) => (s === "line" ? "none" : "line"))} disabled={activeProject.points.length < 2}>
                      <Spline className="mr-1 h-3.5 w-3.5" /> Line
                    </ToggleBtn>
                    <ToggleBtn active={coordShape === "polygon"} onClick={() => setCoordShape((s) => (s === "polygon" ? "none" : "polygon"))} disabled={activeProject.points.length < 3}>
                      <Shapes className="mr-1 h-3.5 w-3.5" /> Polygon
                    </ToggleBtn>
                    <SbBtn className="col-span-2" onClick={flyToAllPoints}>
                      <Maximize2 className="mr-1 h-3.5 w-3.5" /> Fit all points
                    </SbBtn>
                  </div>
                  {coordShape === "line" && lineDist > 0 && (
                    <p className="mt-2 text-[11px] text-cyan-300/80">Total length: <span className="font-semibold text-white">{formatDistance(lineDist)}</span></p>
                  )}
                  {coordShape === "polygon" && polyArea > 0 && (
                    <p className="mt-2 text-[11px] text-cyan-300/80">Area: <span className="font-semibold text-white">{formatArea(polyArea)}</span></p>
                  )}
                </>
              )}
            </Section>

            {/* Datum & projection */}
            <Section
              id="datum"
              icon={<Globe2 className="h-3.5 w-3.5" />}
              title="Datum & projection"
              accent="from-amber-400 to-orange-500"
              open={openSections.datum}
              onToggle={toggleSection}
            >
              <div className="space-y-2.5">
                <div className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-slate-400">
                  <div>Projection: <strong className="text-slate-200">UTM Zone {utmZone}S</strong></div>
                  <div>Ellipsoid: <strong className="text-slate-200">Clarke 1880 (RGS)</strong></div>
                  <div>Datum: <strong className="text-slate-200">Arc 1960 → WGS 84</strong></div>
                </div>

                <div>
                  <FieldLabel>Shift preset (7-parameter)</FieldLabel>
                  <div className="grid grid-cols-3 gap-1">
                    {([
                      { id: "epsg" as const, label: "EPSG" },
                      { id: "controller" as const, label: "Controller" },
                      { id: "custom" as const, label: "Custom" },
                    ]).map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setDatumPreset(opt.id)}
                        className={`rounded-md py-1.5 text-[11px] font-medium transition ${
                          datumPreset === opt.id
                            ? "bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow shadow-amber-500/30"
                            : "bg-white/5 text-slate-300 hover:bg-white/10"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {(["dx", "dy", "dz"] as const).map((k) => (
                    <LabeledInput
                      key={k}
                      label={`D${k[1].toUpperCase()} (m)`}
                      value={String(datumParams[k])}
                      onChange={(v) => setDatumValue(k, v)}
                    />
                  ))}
                  {(["rx", "ry", "rz"] as const).map((k) => (
                    <LabeledInput
                      key={k}
                      label={`R${k[1].toUpperCase()} (″)`}
                      value={String(datumParams[k])}
                      onChange={(v) => setDatumValue(k, v)}
                    />
                  ))}
                  <LabeledInput
                    label="K (ppm)"
                    value={String(datumParams.k)}
                    onChange={(v) => setDatumValue("k", v)}
                  />
                </div>

                <p className="text-[10px] leading-relaxed text-slate-500">
                  Values are applied as <strong>Arc 1960 → WGS 84</strong> (Bursa–Wolf). The "Controller" preset uses the values straight from the RTK controller's Seven Parameters screen (<code>+163, +6, +298</code>, k = +1 ppm).
                  Reserved tokens: H.RMS, V.RMS, geoid model, grid correction (coming soon).
                </p>
              </div>
            </Section>

            {/* Import */}
            <Section
              id="import"
              icon={<FileUp className="h-3.5 w-3.5" />}
              title="Import data"
              accent="from-pink-400 to-rose-500"
              open={openSections.import}
              onToggle={toggleSection}
            >
              <div className="space-y-2">
                <SbBtn className="w-full justify-start" onClick={() => gisInputRef.current?.click()} disabled={importBusy}>
                  <FileUp className="mr-2 h-3.5 w-3.5" /> GIS file (KML/KMZ/GPX/GeoJSON/SHP/CSV)
                </SbBtn>
                <SbBtn className="w-full justify-start" onClick={() => ocrInputRef.current?.click()} disabled={importBusy}>
                  <ImageIcon className="mr-2 h-3.5 w-3.5" /> Image (OCR → coordinates)
                </SbBtn>
                <input ref={gisInputRef} type="file" accept=".kml,.kmz,.gpx,.geojson,.json,.csv,.tsv,.txt,.zip,.shp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleGisFile(f); e.target.value = ""; }} />
                <input ref={ocrInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleOcrFile(f); e.target.value = ""; }} />
                {importBusy && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
                  </div>
                )}
                {importStatus && (
                  <p className="rounded-md bg-white/5 px-2 py-1.5 text-[11px] leading-relaxed text-slate-300">{importStatus}</p>
                )}
                <p className="text-[10px] leading-relaxed text-slate-500">
                  <strong>DWG</strong> cannot be parsed in the browser. Export from AutoCAD/QGIS as <em>DXF, SHP, KML or GeoJSON</em> first. OCR and typed UTM use the datum preset set in <em>Datum &amp; projection</em>.
                </p>
              </div>
            </Section>

            {/* Measure */}
            <Section
              id="measure"
              icon={<Ruler className="h-3.5 w-3.5" />}
              title="Measure"
              accent="from-orange-400 to-red-500"
              open={openSections.measure}
              onToggle={toggleSection}
            >
              <div className="grid grid-cols-2 gap-2">
                <ToggleBtn active={measureMode === "distance"} onClick={() => startMeasure("distance")}>
                  <Ruler className="mr-2 h-3.5 w-3.5" /> Distance
                </ToggleBtn>
                <ToggleBtn active={measureMode === "area"} onClick={() => startMeasure("area")}>
                  <Hexagon className="mr-2 h-3.5 w-3.5" /> Area
                </ToggleBtn>
              </div>
              {measureMode !== "none" && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[11px] text-slate-400">Click to add vertices · Enter or double-click to finish · Backspace to undo · Esc to cancel.</p>
                  <div className="grid grid-cols-3 gap-1">
                    <SbBtn onClick={() => setMeasurePoints((p) => p.slice(0, -1))} disabled={measurePoints.length === 0}>
                      <Undo2 className="mr-1 h-3.5 w-3.5" /> Undo
                    </SbBtn>
                    <button onClick={finishMeasure} className="rounded-md bg-gradient-to-r from-cyan-500 to-blue-600 text-xs font-semibold text-white">Done</button>
                    <button onClick={cancelMeasure} className="rounded-md text-xs text-slate-300 hover:bg-white/5">Cancel</button>
                  </div>
                </div>
              )}
              {activeProject && activeProject.measurements.length > 0 && (
                <>
                  <Separator className="my-3 bg-white/10" />
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Saved · {activeProject.measurements.length}</h3>
                    <button onClick={() => updateActive((p) => ({ ...p, measurements: [] }))} className="text-[10px] text-slate-500 hover:text-rose-400">Clear</button>
                  </div>
                  <ul className="max-h-32 space-y-1 overflow-y-auto pr-1">
                    {activeProject.measurements.map((m, i) => {
                      const val = m.type === "distance"
                        ? formatDistance(lineDistanceMeters(m.points))
                        : formatArea(polygonAreaSqMeters(m.points));
                      return (
                        <li key={m.id} className="group flex items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.03] px-2 py-1 text-xs">
                          <span className="font-mono text-[10px] text-orange-400/70">{String(i + 1).padStart(2, "0")}</span>
                          <span className="flex-1 truncate text-slate-200">{m.type === "distance" ? "↔" : "▢"} {val}</span>
                          <button className="opacity-0 transition group-hover:opacity-100" onClick={() => updateActive((p) => ({ ...p, measurements: p.measurements.filter((x) => x.id !== m.id) }))}>
                            <X className="h-3.5 w-3.5 text-rose-400" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </Section>

            {/* Parcel info */}
            <Section
              id="info"
              icon={<Info className="h-3.5 w-3.5" />}
              title="Parcel info"
              accent="from-slate-400 to-slate-500"
              open={openSections.info}
              onToggle={toggleSection}
            >
              {selected ? (
                <>
                  <dl className="space-y-2 text-sm">
                    <Row label="Parcel" value={String(selected.properties?.parcel_number)} />
                    <Row label="Area" value={formatArea(geojsonPolygonArea(selected.geometry))} />
                    <Row label="Perimeter" value={formatDistance(geojsonPolygonPerimeter(selected.geometry))} />
                    <Row label="Source" value={String(selected.properties?.source ?? "RIM Map")} />
                  </dl>
                  <Separator className="my-3 bg-white/10" />
                  <div className="grid grid-cols-2 gap-2">
                    <SbBtn onClick={exportGeoJSON}><Download className="mr-2 h-3.5 w-3.5" /> GeoJSON</SbBtn>
                    <SbBtn onClick={exportKML}><Download className="mr-2 h-3.5 w-3.5" /> KML</SbBtn>
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-400">
                  {hasParcels
                    ? "Click a parcel on the map or search by number."
                    : "Siana RIM parcel data not loaded yet. Once provided, parcels and their details will appear here."}
                </p>
              )}
            </Section>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center gap-1 py-3">
            {([
              { id: "projects" as const, icon: FolderOpen },
              { id: "coords" as const, icon: Navigation },
              { id: "datum" as const, icon: Globe2 },
              { id: "import" as const, icon: FileUp },
              { id: "measure" as const, icon: Ruler },
              { id: "layers" as const, icon: Layers },
              { id: "info" as const, icon: Info },
            ]).map(({ id, icon: Icon }) => (
              <button
                key={id}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-cyan-300"
                onClick={() => { setSidebarOpen(true); setOpenSections((s) => ({ ...s, [id]: true })); }}
                title={id}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Map */}
      <div className="relative flex-1">
        {mounted ? (
          <Suspense fallback={<MapFallback />}>
            <MapView
              parcels={parcels}
              showParcels={showParcels && hasParcels}
              selectedId={selectedId}
              onSelect={handleSelect}
              flyTo={flyTo}
              fitBounds={fitBounds}
              measureMode={measureMode}
              measurePoints={measurePoints}
              onMeasurePoint={(pt) => setMeasurePoints((p) => [...p, pt])}
              onMeasureFinish={finishMeasure}
              gpsPosition={gpsPosition}
              pinnedPoint={null}
              coordPoints={activeProject?.points ?? []}
              coordShape={coordShape}
              savedMeasurements={activeProject?.measurements ?? []}
            />
          </Suspense>
        ) : (
          <MapFallback />
        )}

        {measureMode !== "none" && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-full border border-orange-500/40 bg-orange-500/15 px-3 py-1.5 text-xs text-orange-100 shadow-lg backdrop-blur">
            {measureMode === "distance" ? "Measure distance" : "Measure area"} — {measurePoints.length} point{measurePoints.length === 1 ? "" : "s"}
          </div>
        )}

        {mounted && (
          <Suspense fallback={null}>
            <GpsCompass
              points={activeProject?.points ?? []}
              onPosition={setGpsPosition}
              onLocate={(p) => setFlyTo({ lat: p.lat, lng: p.lng, zoom: 18 })}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  icon,
  accent,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  icon: React.ReactNode;
  accent: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-white/5 bg-white/[0.025] shadow-sm">
      <button
        onClick={() => onToggle(id)}
        className="group flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition hover:bg-white/[0.04]"
      >
        <span className="flex items-center gap-2.5">
          <span className={`flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br ${accent} text-white shadow shadow-black/30`}>
            {icon}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-200">{title}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-slate-500 transition ${open ? "rotate-0" : "-rotate-90"}`} />
      </button>
      {open && <div className="border-t border-white/5 p-3">{children}</div>}
    </section>
  );
}

function SbBtn({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-cyan-400/30 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

function ToggleBtn({
  active,
  children,
  onClick,
  disabled,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow shadow-cyan-500/30"
          : "border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
      {children}
    </label>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  inputMode = "decimal",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "text" | "decimal" | "numeric";
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className="h-8 w-full rounded-md border border-white/10 bg-white/5 px-2 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none"
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-slate-400">{label}</dt>
      <dd className="text-right text-sm font-medium tabular-nums text-white">{value}</dd>
    </div>
  );
}

function MapFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[oklch(0.14_0.03_260)] text-sm text-slate-400">
      Loading map…
    </div>
  );
}
