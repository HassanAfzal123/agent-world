"""Short observation focused on talk, asks, relationships, moments."""
from __future__ import annotations

import json
import os
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

WORLD = os.environ.get("AGENTWORLD_URL", "http://127.0.0.1:3000")
ROOT = Path(__file__).resolve().parent
OUT = ROOT / "observation_run.jsonl"
SUMMARY = ROOT / "observation_summary.json"
MINUTES = int(os.environ.get("OBS_MINUTES", "6"))


def post(path: str, timeout: int = 600):
    req = urllib.request.Request(f"{WORLD}{path}", method="POST", data=b"")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    OUT.write_text("", encoding="utf-8")
    end = time.time() + MINUTES * 60
    pass_n = 0
    last_walk = 0.0
    print(f"OBS start {datetime.now().isoformat()} for {MINUTES}m", flush=True)
    while time.time() < end:
        pass_n += 1
        now = time.time()
        if now - last_walk >= 8:
            try:
                for _ in range(5):
                    post("/api/city/walk", timeout=30)
                last_walk = time.time()
            except Exception as exc:  # noqa: BLE001
                print(f"walk err: {exc}", flush=True)

        t0 = time.time()
        try:
            tick = post("/api/city/tick", timeout=600)
        except Exception as exc:  # noqa: BLE001
            print(f"pass {pass_n} FAIL {exc}", flush=True)
            time.sleep(8)
            continue
        secs = round(time.time() - t0, 1)
        acted = []
        for a in tick.get("acted") or []:
            if a.get("note"):
                continue
            d = a.get("decision") or {}
            acted.append(
                {
                    "agent": a.get("agent"),
                    "llm": bool(a.get("used_llm")),
                    "action": d.get("action"),
                    "place": d.get("target_place"),
                    "thought": (d.get("thought") or "")[:160],
                    "say": (d.get("utterance") or "")[:160],
                }
            )
        row = {
            "pass": pass_n,
            "at": datetime.now(timezone.utc).isoformat(),
            "secs": secs,
            "tick": tick.get("tick"),
            "hour": tick.get("hour"),
            "event": tick.get("event"),
            "acted": acted,
        }
        with OUT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        print(
            f"pass {pass_n} tick={row['tick']} {secs}s n={len(acted)} event={row['event']}",
            flush=True,
        )
        for a in acted:
            print(
                f"  {str(a['agent']):<6} llm={a['llm']} {str(a['action']):<16} {(a['thought'] or '')[:70]}",
                flush=True,
            )
            if a["say"]:
                print(f"         say: {a['say'][:100]}", flush=True)

        sleep_for = max(4, 40 - (time.time() - t0))
        if time.time() + sleep_for >= end:
            break
        time.sleep(sleep_for)

    SUMMARY.write_text(
        json.dumps(
            {"passes": pass_n, "minutes": MINUTES, "log": str(OUT)},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"OBS_DONE passes={pass_n}", flush=True)


if __name__ == "__main__":
    main()
