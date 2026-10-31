"""Smoke test the Bun fallback over its HTTP surface."""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUN = Path(r"C:\Users\sachc\.bun\bin\bun.exe")
PORT = int(os.environ.get("FALLBACK_TEST_PORT", "7399"))
BASE = f"http://127.0.0.1:{PORT}"


def request(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=2) as response:
        assert response.headers.get("X-Sim-Mode") == "fallback"
        return json.loads(response.read())


def wait_for_tick(target):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if request("/health")["tick"] >= target:
            return
        time.sleep(0.1)
    raise AssertionError(f"simulator did not reach tick {target}")


def main():
    env = {**os.environ, "PORT": str(PORT), "SIM_FAST": "0", "GLUE_URL": "http://127.0.0.1:9"}
    process = subprocess.Popen([str(BUN), str(ROOT / "bridge" / "fallback.ts")], cwd=ROOT, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 8
        while True:
            try:
                request("/health")
                break
            except Exception:
                if process.poll() is not None:
                    raise AssertionError("fallback process exited during startup")
                if time.monotonic() >= deadline:
                    raise AssertionError("fallback did not start")
                time.sleep(0.1)

        initial = request("/snapshot?plantId=plant-a")
        assert len(initial) == 5
        assert request("/reset", {})["reset"] is True

        command = {"componentId": "plant-a/P-100", "metric": "speedPct", "value": 65, "proposalId": "smoke-65"}
        accepted = request("/setpoint", command)
        assert accepted["accepted"] is True
        assert request("/setpoint", command) == accepted  # proposalId is idempotent
        wait_for_tick(accepted["tick"] + 5)
        snap = request("/snapshot?plantId=plant-a")
        assert 65 <= snap["plant-a/LV-101"]["positionPct"] <= 68
        assert abs(snap["plant-a/TK-101"]["tempC"] - 75) <= 1
        observed = request("/observed?proposalId=smoke-65")
        assert observed["proposalId"] == "smoke-65" and observed["effects"]
        assert set(observed["effects"][0]) == {"componentId", "metric", "before", "after", "ticksToSettle"}
        try:
            request("/observed?proposalId=nope")
            raise AssertionError("unknown proposalId should 404")
        except urllib.error.HTTPError as e:
            assert e.code == 404 and e.headers.get("X-Sim-Mode") == "fallback"
        try:
            request("/setpoint", {**command, "proposalId": "bad", "metric": "dutyKw", "componentId": "plant-a/E-101", "value": 10})
            raise AssertionError("observable metric should be rejected")
        except urllib.error.HTTPError as e:
            assert e.code == 400

        request("/reset", {})
        accepted = request("/setpoint", {**command, "value": 85, "proposalId": "smoke-85"})
        assert request("/observed?proposalId=smoke-85") == {"proposalId": "smoke-85", "pending": True}
        wait_for_tick(accepted["tick"] + 3)
        snap = request("/snapshot")
        assert len(snap) == 10
        assert snap["plant-a/LV-101"]["positionPct"] >= 85
        assert snap["plant-b/TV-101"]["headerBarg"] < 6  # shared steam header drops
        assert snap["plant-b/TV-101"]["positionPct"] > 50.5  # plant-b TV-101 opens further

        request("/reset", {})
        accepted = request("/setpoint", {**command, "value": 100, "proposalId": "smoke-100"})
        wait_for_tick(accepted["tick"] + 1)
        snap = request("/snapshot?plantId=plant-a")
        assert snap["plant-a/LV-101"]["positionPct"] == 100
        assert snap["plant-a/TK-101"]["levelPct"] > 50
        print("fallback smoke test passed")
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == "__main__":
    main()
