import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Navigation2, X, ChevronDown, ChevronUp, Volume2, VolumeX } from "lucide-react";
import type { CoordPoint } from "@/lib/projects";

type Props = {
  points: CoordPoint[];
  onPosition?: (pos: { lat: number; lng: number; accuracy: number } | null) => void;
  onLocate?: (pos: { lat: number; lng: number }) => void;
};

function toRad(d: number) {
  return (d * Math.PI) / 180;
}
function toDeg(r: number) {
  return (r * 180) / Math.PI;
}

/** Great-circle distance in meters. */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing (deg, 0-360, clockwise from N) from A to B. */
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function fmtDist(m: number): string {
  if (m < 1) return `${(m * 100).toFixed(0)} cm`;
  if (m < 1000) return `${m.toFixed(1)} m`;
  return `${(m / 1000).toFixed(3)} km`;
}

function cardinal(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

export default function GpsCompass({ points, onPosition, onLocate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [pos, setPos] = useState<{ lat: number; lng: number; accuracy: number } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [heading, setHeading] = useState<number | null>(null); // device heading, deg
  const [targetId, setTargetId] = useState<string>("");
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("gps-compass-muted") === "1";
  });
  const watchIdRef = useRef<number | null>(null);
  const orientationBoundRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastBeepRef = useRef<number>(0);
  const arrivedRef = useRef<boolean>(false);

  const ensureAudio = () => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };

  const beep = (freq: number, durationMs: number, gain = 0.15) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.02);
  };

  const toggleMuted = () => {
    setMuted((m) => {
      const next = !m;
      try {
        window.localStorage.setItem("gps-compass-muted", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const target = useMemo(
    () => points.find((p) => p.id === targetId) ?? null,
    [points, targetId],
  );

  // Auto-pick most recent point as target when none selected
  useEffect(() => {
    if (!targetId && points.length > 0) setTargetId(points[points.length - 1].id);
    if (targetId && !points.some((p) => p.id === targetId)) setTargetId("");
  }, [points, targetId]);

  // Start / stop geolocation watch
  useEffect(() => {
    if (!tracking) return;
    if (!("geolocation" in navigator)) {
      setErr("Geolocation not supported.");
      setTracking(false);
      return;
    }
    setErr(null);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const next = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
        };
        setPos(next);
        onPosition?.(next);
      },
      (e) => setErr(e.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
    watchIdRef.current = id;
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
  }, [tracking, onPosition]);

  // Device orientation for compass heading
  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;

    const handler = (e: DeviceOrientationEvent) => {
      // iOS Safari exposes webkitCompassHeading (0-360, clockwise from N)
      // Android/Chrome exposes alpha (0-360, counter-clockwise from N when absolute)
      const wk = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof wk === "number") {
        setHeading(wk);
      } else if (typeof e.alpha === "number") {
        // when e.absolute is true, alpha is relative to north; convert to clockwise heading
        const h = e.absolute ? (360 - e.alpha) % 360 : (360 - e.alpha) % 360;
        setHeading(h);
      }
    };

    const bind = () => {
      if (orientationBoundRef.current) return;
      window.addEventListener("deviceorientationabsolute", handler as EventListener);
      window.addEventListener("deviceorientation", handler);
      orientationBoundRef.current = true;
    };

    const DOE = (window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
    }).DeviceOrientationEvent;
    if (DOE?.requestPermission) {
      DOE.requestPermission()
        .then((state) => {
          if (!cancelled && state === "granted") bind();
        })
        .catch(() => {});
    } else {
      bind();
    }

    return () => {
      cancelled = true;
      if (orientationBoundRef.current) {
        window.removeEventListener("deviceorientationabsolute", handler as EventListener);
        window.removeEventListener("deviceorientation", handler);
        orientationBoundRef.current = false;
      }
    };
  }, [tracking]);

  const targetBearing =
    pos && target ? bearing(pos.lat, pos.lng, target.lat, target.lng) : null;
  const targetDistance =
    pos && target ? haversine(pos.lat, pos.lng, target.lat, target.lng) : null;

  // Proximity beep scheduler
  useEffect(() => {
    if (!tracking || muted || targetDistance === null) {
      arrivedRef.current = false;
      return;
    }
    const d = targetDistance;
    if (d > 50) {
      arrivedRef.current = false;
      return;
    }
    let interval: number;
    let freq: number;
    if (d > 20) {
      interval = 2000;
      freq = 600;
    } else if (d > 5) {
      interval = 800;
      freq = 900;
    } else if (d > 1) {
      interval = 300;
      freq = 1200;
    } else {
      interval = 150;
      freq = 1500;
    }
    const ctx = ensureAudio();
    if (!ctx) return;
    // Arrival chime (one-shot when first entering <1m)
    if (d <= 1 && !arrivedRef.current) {
      arrivedRef.current = true;
      beep(1200, 120);
      window.setTimeout(() => beep(1600, 120), 140);
      window.setTimeout(() => beep(2000, 200), 300);
    }
    if (d > 1) arrivedRef.current = false;

    const tick = () => {
      const now = performance.now();
      if (now - lastBeepRef.current >= interval) {
        lastBeepRef.current = now;
        beep(freq, 90);
      }
    };
    tick();
    const id = window.setInterval(tick, Math.min(interval, 200));
    return () => window.clearInterval(id);
  }, [tracking, muted, targetDistance]);

  // Rose rotation: rotate the rose so that current heading points up.
  // If no heading available, keep N up.
  const roseRotation = heading !== null ? -heading : 0;
  // Arrow points toward target relative to the user's facing direction.
  const arrowRotation =
    targetBearing !== null && heading !== null
      ? (targetBearing - heading + 360) % 360
      : targetBearing ?? 0;

  const stopTracking = () => {
    setTracking(false);
    setPos(null);
    setHeading(null);
    onPosition?.(null);
  };

  const accuracyColor =
    pos == null
      ? "text-slate-400"
      : pos.accuracy <= 5
        ? "text-emerald-400"
        : pos.accuracy <= 15
          ? "text-amber-300"
          : "text-rose-400";

  // Collapsed floating button
  if (!expanded) {
    return (
      <button
        onClick={() => {
          setExpanded(true);
          if (!tracking) setTracking(true);
          ensureAudio();
        }}
        className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+3.75rem)] right-4 z-[1200] flex h-14 w-14 flex-col items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-blue-500 to-cyan-600 text-white shadow-2xl shadow-blue-500/40 transition hover:scale-105 active:scale-95"
        aria-label="Open GPS compass"
        title="GPS compass"
      >
        <Crosshair className="h-6 w-6" />
        {tracking && (
          <span className="absolute right-1 top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_oklch(0.75_0.18_150)]" />
        )}
        {pos && (
          <span
            className={`absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/10 bg-slate-900/90 px-1.5 py-0.5 text-[9px] font-mono font-semibold ${accuracyColor}`}
          >
            ±{pos.accuracy.toFixed(0)}m
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+3.75rem)] right-4 z-[1200] max-h-[calc(100%-5rem)] w-[280px] overflow-y-auto overflow-hidden rounded-2xl border border-white/10 bg-slate-900/85 text-slate-100 shadow-2xl shadow-black/50 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              tracking && pos
                ? "animate-pulse bg-emerald-400 shadow-[0_0_6px_oklch(0.75_0.18_150)]"
                : tracking
                  ? "bg-amber-400"
                  : "bg-slate-500"
            }`}
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-200">
            GPS Compass
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleMuted}
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white"
            aria-label={muted ? "Unmute proximity beep" : "Mute proximity beep"}
            title={muted ? "Unmute beep" : "Mute beep"}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setExpanded(false)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white"
            aria-label="Minimize"
            title="Minimize"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Compass rose */}
      <div className="flex flex-col items-center px-3 pt-3">
        <div className="relative h-[200px] w-[200px]">
          {/* Rotating rose */}
          <svg
            viewBox="-110 -110 220 220"
            className="absolute inset-0 h-full w-full transition-transform duration-200 ease-out"
            style={{ transform: `rotate(${roseRotation}deg)` }}
          >
            <circle
              r="98"
              fill="oklch(0.18 0.03 260)"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth="1"
            />
            {/* Tick marks */}
            {Array.from({ length: 72 }).map((_, i) => {
              const angle = i * 5;
              const isMajor = angle % 30 === 0;
              const isMid = !isMajor && angle % 10 === 0;
              const r1 = 90;
              const r2 = isMajor ? 76 : isMid ? 82 : 86;
              const a = toRad(angle - 90);
              return (
                <line
                  key={i}
                  x1={r1 * Math.cos(a)}
                  y1={r1 * Math.sin(a)}
                  x2={r2 * Math.cos(a)}
                  y2={r2 * Math.sin(a)}
                  stroke={
                    isMajor
                      ? "rgba(255,255,255,0.75)"
                      : isMid
                        ? "rgba(255,255,255,0.4)"
                        : "rgba(255,255,255,0.2)"
                  }
                  strokeWidth={isMajor ? 1.4 : 1}
                />
              );
            })}
            {/* Cardinal labels */}
            {[
              { l: "N", a: 0, color: "#f43f5e" },
              { l: "E", a: 90, color: "#93c5fd" },
              { l: "S", a: 180, color: "#93c5fd" },
              { l: "W", a: 270, color: "#93c5fd" },
            ].map(({ l, a, color }) => {
              const r = 62;
              const rad = toRad(a - 90);
              const x = r * Math.cos(rad);
              const y = r * Math.sin(rad);
              return (
                <text
                  key={l}
                  x={x}
                  y={y}
                  fill={color}
                  fontSize="14"
                  fontWeight={l === "N" ? 700 : 600}
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ transform: `rotate(${-roseRotation}deg)`, transformOrigin: `${x}px ${y}px` }}
                >
                  {l}
                </text>
              );
            })}
            {/* Degree numbers every 30° */}
            {[30, 60, 120, 150, 210, 240, 300, 330].map((a) => {
              const r = 46;
              const rad = toRad(a - 90);
              const x = r * Math.cos(rad);
              const y = r * Math.sin(rad);
              return (
                <text
                  key={a}
                  x={x}
                  y={y}
                  fill="rgba(148,163,184,0.7)"
                  fontSize="8"
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ transform: `rotate(${-roseRotation}deg)`, transformOrigin: `${x}px ${y}px` }}
                >
                  {a}°
                </text>
              );
            })}
            {/* North indicator triangle (fixed to rose) */}
            <polygon
              points="0,-96 -5,-86 5,-86"
              fill="#f43f5e"
              stroke="#f43f5e"
              strokeWidth="1"
            />
          </svg>

          {/* Target arrow (rotates independently) */}
          {target && targetBearing !== null && (
            <svg
              viewBox="-110 -110 220 220"
              className="absolute inset-0 h-full w-full transition-transform duration-200 ease-out"
              style={{ transform: `rotate(${arrowRotation}deg)` }}
            >
              {/* Big blue arrow pointing to target */}
              <polygon
                points="0,-70 -16,10 0,-4 16,10"
                fill="#3b82f6"
                stroke="#1d4ed8"
                strokeWidth="1.2"
                style={{
                  filter: "drop-shadow(0 0 6px rgba(59,130,246,0.6))",
                }}
              />
            </svg>
          )}

          {/* Center puck (user) */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white/70 bg-blue-500 shadow-lg">
            <div className="h-2 w-2 rounded-full bg-white" />
          </div>
        </div>

        {/* Live readouts */}
        <div className="mt-3 grid w-full grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-md bg-white/5 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-widest text-slate-400">Heading</div>
            <div className="font-mono text-sm text-white">
              {heading !== null ? `${heading.toFixed(0)}° ${cardinal(heading)}` : "—"}
            </div>
          </div>
          <div className="rounded-md bg-white/5 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-widest text-slate-400">Accuracy</div>
            <div className={`font-mono text-sm font-semibold ${accuracyColor}`}>
              {pos ? `±${pos.accuracy.toFixed(0)} m` : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Target section */}
      <div className="mt-2 border-t border-white/10 px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Navigate to
          </span>
          {target && (
            <button
              onClick={() => setTargetId("")}
              className="text-[10px] text-slate-500 hover:text-rose-400"
            >
              Clear
            </button>
          )}
        </div>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="h-8 w-full rounded-md border border-white/10 bg-white/5 px-2 text-xs text-white focus:border-cyan-400/60 focus:outline-none"
          disabled={points.length === 0}
        >
          <option value="" className="bg-slate-800">
            {points.length === 0 ? "No points yet — add one first" : "Select a target point…"}
          </option>
          {points.map((p, i) => (
            <option key={p.id} value={p.id} className="bg-slate-800">
              {String(i + 1).padStart(2, "0")} · {p.label}
            </option>
          ))}
        </select>

        {target && targetBearing !== null && targetDistance !== null && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-md bg-blue-500/10 px-2 py-1.5 ring-1 ring-blue-500/30">
              <div className="text-[9px] uppercase tracking-widest text-blue-300">Distance</div>
              <div className="font-mono text-sm font-semibold text-white">
                {fmtDist(targetDistance)}
              </div>
            </div>
            <div className="rounded-md bg-blue-500/10 px-2 py-1.5 ring-1 ring-blue-500/30">
              <div className="text-[9px] uppercase tracking-widest text-blue-300">Bearing</div>
              <div className="font-mono text-sm font-semibold text-white">
                {targetBearing.toFixed(0)}° {cardinal(targetBearing)}
              </div>
            </div>
          </div>
        )}

        {target && heading === null && tracking && (
          <p className="mt-2 text-[10px] leading-relaxed text-amber-300/80">
            Rotate your phone to activate the compass. On iOS you must tap "Allow" for motion &amp; orientation access.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 border-t border-white/10 bg-black/20 px-3 py-2">
        {tracking ? (
          <button
            onClick={stopTracking}
            className="flex-1 rounded-md bg-white/5 px-2 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => setTracking(true)}
            className="flex-1 rounded-md bg-gradient-to-r from-blue-500 to-cyan-600 px-2 py-1.5 text-xs font-semibold text-white shadow shadow-blue-500/30 transition hover:from-blue-400 hover:to-cyan-500"
          >
            Start tracking
          </button>
        )}
        {pos && (
          <button
            onClick={() => onLocate?.({ lat: pos.lat, lng: pos.lng })}
            className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10"
            title="Center map on me"
          >
            <Navigation2 className="h-3.5 w-3.5" /> Center
          </button>
        )}
      </div>

      {err && (
        <div className="flex items-start gap-1.5 border-t border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
          <X className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {/* Collapse arrow at bottom too */}
      <button
        onClick={() => setExpanded(false)}
        className="flex w-full items-center justify-center gap-1 border-t border-white/10 py-1 text-[10px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
      >
        <ChevronUp className="h-3 w-3" /> Minimize
      </button>
    </div>
  );
}