"""Live two-plant simulation with a shared steam header, served over HTTP.

Run:  python bridge/live_sim.py [--fast] [--port 7300] [--tick-seconds 1.0]
Env:  GLUE_URL (default http://127.0.0.1:7200), SIM_PORT, SIM_TICK_S, SIM_FAST=1

1 tick = 18 controller scans of 10 s = 180 simulated seconds, run once per
wall second (or every SIM_TICK_S / 0.05 s with --fast).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tank_model import SCANS_PER_TICK, TankPlant  # noqa: E402

PLANTS = ("plant-a", "plant-b")
TAGS = ("P-100", "TK-101", "LV-101", "E-101", "TV-101")
# Commandable setpoints and their accepted ranges.
COMMANDS = {("P-100", "speedPct"): (20., 100.), ("TK-101", "levelPct"): (20., 70.),
            ("TK-101", "tempC"): (70., 80.)}
OBSERVABLE = {("P-100", "feedM3h"), ("LV-101", "positionPct"), ("E-101", "dutyKw"),
              ("TV-101", "positionPct"), ("TV-101", "steamKgH"), ("TV-101", "headerBarg")}
HEADER_DESIGN_BARG, HEADER_GAIN, HEADER_DESIGN_KGH = 6.0, 0.0005, 3066.0
HEADER_MIN, HEADER_MAX = 4.5, 6.5
OBSERVE_TICKS = 5
MOVED_EPS = 1e-3


def header_pressure(total_steam_kgh: float) -> float:
    p = HEADER_DESIGN_BARG - HEADER_GAIN * (total_steam_kgh - HEADER_DESIGN_KGH)
    return max(HEADER_MIN, min(HEADER_MAX, p))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(*parts):
    print(f"[live_sim {now_iso()}]", *parts, flush=True)


class GluePusher:
    """Best-effort POSTs to glue on a background thread.

    Mirrors are coalesced per componentId (latest wins), so a slow or absent
    glue never builds a backlog or delays the tick loop. Failures are logged
    once per failure streak.
    """

    def __init__(self, base_url: str | None = None, timeout: float = 0.3):
        self.base = (base_url or os.getenv("GLUE_URL", "http://127.0.0.1:7200")).rstrip("/")
        self.timeout = timeout
        self.cv = threading.Condition()
        self.mirrors: dict[str, dict] = {}
        self.observed: list[dict] = []
        self.failing = False
        self.sent = 0
        threading.Thread(target=self._run, daemon=True, name="glue-pusher").start()

    def mirror(self, cid: str, payload: dict):
        with self.cv:
            self.mirrors[cid] = payload; self.cv.notify()

    def observe(self, payload: dict):
        with self.cv:
            self.observed.append(payload); self.cv.notify()

    def _post(self, path: str, payload: dict):
        try:
            req = urllib.request.Request(self.base + path, json.dumps(payload).encode(),
                                         {"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=self.timeout).read()
            if self.failing: log(f"glue reachable again at {self.base}")
            self.failing = False; self.sent += 1
        except Exception as e:  # noqa: BLE001 - best effort by design
            if not self.failing: log(f"glue unavailable ({self.base}{path}): {e}; will keep retrying quietly")
            self.failing = True

    def _run(self):
        while True:
            with self.cv:
                while not self.mirrors and not self.observed: self.cv.wait()
                observed, self.observed = self.observed, []
                mirrors, self.mirrors = self.mirrors, {}
            for ob in observed: self._post("/observed", ob)
            for payload in mirrors.values(): self._post("/mirror", payload)


class Simulator:
    def __init__(self, fast: bool = False, pusher: GluePusher | None = None, push: bool = True):
        self.lock = threading.RLock()
        self.fast = fast
        self.tick = 0
        self.plants = {p: TankPlant() for p in PLANTS}
        self.header = HEADER_DESIGN_BARG
        self.results: dict[str, dict] = {}       # proposalId -> setpoint result (idempotency)
        self.observations: dict[str, dict] = {}  # proposalId -> {proposalId, effects}
        self.observers: list[dict] = []
        self.pusher = pusher if pusher is not None else (GluePusher() if push else None)

    # -- state ------------------------------------------------------------
    def component_metrics(self, plant: str) -> dict[str, dict[str, float]]:
        return {f"{plant}/{tag}": m for tag, m in self.plants[plant].metrics().items()}

    def snapshot(self, plant: str | None = None) -> dict[str, dict[str, float]]:
        with self.lock:
            out: dict[str, dict[str, float]] = {}
            for p in ((plant,) if plant else PLANTS): out.update(self.component_metrics(p))
            return out

    def _mirror_all(self, snap):
        if self.pusher is None: return
        stamp = now_iso()
        for cid, metrics in snap.items():
            self.pusher.mirror(cid, {"componentId": cid, "metrics": metrics, "lastTick": stamp, "tick": self.tick})

    # -- stepping ---------------------------------------------------------
    def step(self) -> dict[str, dict[str, float]]:
        with self.lock:
            for _ in range(SCANS_PER_TICK):
                for q in self.plants.values():
                    q.set_header(self.header); q.scan()
                # Shared header: both plants' steam draw sets the pressure both see next scan.
                self.header = header_pressure(sum(q.snapshot()["FI-201"] for q in self.plants.values()))
            for q in self.plants.values(): q.set_header(self.header)
            self.tick += 1
            snap = self.snapshot()
            self._mirror_all(snap)
            for ob in list(self.observers):
                ob["samples"].append(snap)
                if len(ob["samples"]) >= OBSERVE_TICKS:
                    observation = {"proposalId": ob["proposalId"], "effects": self._effects(ob)}
                    self.observations[ob["proposalId"]] = observation
                    self.observers.remove(ob)
                    if self.pusher is not None: self.pusher.observe(observation)
                    log("observed", json.dumps(observation))
            return snap

    @staticmethod
    def _effects(ob) -> list[dict]:
        effects = []
        samples = ob["samples"]
        for cid, metrics in samples[-1].items():
            for metric, after in metrics.items():
                before = ob["before"].get(cid, {}).get(metric)
                if before is None or abs(after - before) <= MOVED_EPS * max(1., abs(before)): continue
                tol = max(0.05 * abs(after - before), MOVED_EPS)
                settle = len(samples)
                for k in range(len(samples), 0, -1):
                    if abs(samples[k - 1][cid][metric] - after) <= tol: settle = k
                    else: break
                effects.append({"componentId": cid, "metric": metric, "before": before,
                                "after": after, "ticksToSettle": settle})
        return effects

    # -- commands ---------------------------------------------------------
    def command(self, cid, metric, value, pid):
        with self.lock:
            if pid in self.results:
                log("setpoint retry", pid, "-> original result")
                return self.results[pid]
            try:
                return self._command(cid, metric, value, pid)
            except ValueError as e:
                log("setpoint rejected", json.dumps({"proposalId": pid, "componentId": cid,
                                                       "metric": metric, "value": value}), str(e))
                raise

    def _command(self, cid, metric, value, pid):
        if not isinstance(pid, str) or not pid: raise ValueError("proposalId must be a non-empty string")
        parts = cid.split("/") if isinstance(cid, str) else []
        if len(parts) != 2 or parts[0] not in self.plants or parts[1] not in TAGS:
            raise ValueError(f"unknown componentId {cid!r}")
        plant, tag = parts
        key = (tag, metric)
        if key in OBSERVABLE: raise ValueError(f"{tag}.{metric} is observed, not commandable")
        if key not in COMMANDS: raise ValueError(f"unknown metric {metric!r} for {tag}")
        lo, hi = COMMANDS[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
            raise ValueError(f"{tag}.{metric} value must be a number in [{lo:g}, {hi:g}]")
        before = self.snapshot()
        q = self.plants[plant]
        previous = before[cid][metric]
        if key == ("P-100", "speedPct"): q.set_speed(value)
        elif key == ("TK-101", "tempC"): previous = q.loops["TIC-101"].sp; q.set_temperature_sp(value)
        else: previous = q.loops["LIC-101"].sp / 4 * 100; q.set_level_sp(value / 100 * 4)
        result = {"proposalId": pid, "componentId": cid, "metric": metric, "value": float(value),
                  "previous": previous, "accepted": True, "tick": self.tick, "at": now_iso()}
        self.results[pid] = result
        self.observers.append({"proposalId": pid, "before": before, "samples": [], "startTick": self.tick})
        log("setpoint", json.dumps(result))
        return result

    def observed(self, pid: str):
        with self.lock:
            if pid in self.observations: return 200, self.observations[pid]
            if pid in self.results:
                ob = next((o for o in self.observers if o["proposalId"] == pid), None)
                return 202, {"proposalId": pid, "pending": True,
                             "ticksRemaining": OBSERVE_TICKS - len(ob["samples"]) if ob else 0}
            return 404, {"error": f"unknown proposalId {pid!r}"}

    def reset(self):
        with self.lock:
            for q in self.plants.values(): q.reset(speed=50.)
            self.header = HEADER_DESIGN_BARG
            self.tick = 0
            self.results.clear(); self.observers.clear(); self.observations.clear()
            snap = self.snapshot()
            self._mirror_all(snap)
            log("reset both plants to design steady state")
            return {"reset": True, "tick": self.tick, "snapshot": snap}


sim: Simulator | None = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def send(self, status, obj):
        blob = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers(); self.wfile.write(blob)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path); qs = parse_qs(url.query)
        if url.path == "/health":
            return self.send(200, {"ok": True, "tick": sim.tick, "headerBarg": sim.header,
                                   "fast": sim.fast, "plants": list(PLANTS)})
        if url.path == "/snapshot":
            p = qs.get("plantId", [None])[0]
            if p and p not in sim.plants: return self.send(400, {"error": f"unknown plantId {p!r}"})
            return self.send(200, sim.snapshot(p or None))
        if url.path == "/observed":
            pid = qs.get("proposalId", [None])[0]
            if not pid: return self.send(400, {"error": "proposalId required"})
            return self.send(*sim.observed(pid))
        self.send(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            data = json.loads(raw) if raw else {}
            if not isinstance(data, dict): raise ValueError
        except Exception:
            return self.send(400, {"error": "invalid JSON body"})
        if url.path == "/setpoint":
            missing = [f for f in ("componentId", "metric", "value", "proposalId") if f not in data]
            if missing: return self.send(400, {"error": f"missing {', '.join(missing)}"})
            try:
                return self.send(200, sim.command(data["componentId"], data["metric"], data["value"], data["proposalId"]))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
        if url.path == "/reset": return self.send(200, sim.reset())
        self.send(404, {"error": "not found"})


def run(fast=False, port=7300, tick_seconds=None):
    global sim
    sim = Simulator(fast)
    period = tick_seconds if tick_seconds is not None else (0.05 if fast else 1.0)
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            start = time.monotonic()
            try: sim.step()
            except Exception as e:  # noqa: BLE001 - never let one bad tick kill the plant
                log("tick failed:", repr(e))
            stop.wait(max(0., period - (time.monotonic() - start)))

    threading.Thread(target=loop, daemon=True, name="tick-loop").start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    log(f"listening on 127.0.0.1:{port}, tick every {period}s (= 180 simulated s), glue {sim.pusher.base}")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: stop.set(); server.server_close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", default=os.getenv("SIM_FAST", "0").lower() in ("1", "true", "yes"))
    ap.add_argument("--port", type=int, default=int(os.getenv("SIM_PORT", "7300")))
    ap.add_argument("--tick-seconds", type=float, default=float(os.environ["SIM_TICK_S"]) if os.getenv("SIM_TICK_S") else None)
    a = ap.parse_args()
    run(a.fast, a.port, a.tick_seconds)
