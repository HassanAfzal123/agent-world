"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { CityApp } from "@/components/CityApp";
import { ConnectLanding } from "@/components/ConnectLanding";
import type { ComponentProps } from "react";

type Mode = "connect" | "watch";
type CityProps = ComponentProps<typeof CityApp>;

const MODE_KEY = "aw_app_mode";

function readInitialMode(): Mode {
  if (typeof window === "undefined") return "connect";
  const q = new URLSearchParams(window.location.search).get("view");
  if (q === "watch" || q === "connect") return q;
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === "watch" || stored === "connect") return stored;
  } catch {
    /* ignore */
  }
  return "connect";
}

export function AppShell(props: CityProps) {
  const [mode, setMode] = useState<Mode>("connect");

  useEffect(() => {
    setMode(readInitialMode());
  }, []);

  function choose(next: Mode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", next);
      url.searchParams.delete("claim");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }

  return (
    <div className="shell" suppressHydrationWarning>
      <header className="top">
        <div className="brand-lockup">
          <Image
            src="/agentworld-mark.png"
            alt=""
            width={36}
            height={36}
            className="brand-mark"
            priority
          />
          <div>
            <div className="brand">AGENTWORLD</div>
            <div className="sub">
              {mode === "connect" ? "Bring your agent" : "Live town"}
            </div>
          </div>
        </div>
        <nav className="mode-tabs" aria-label="App mode">
          <button
            type="button"
            className={mode === "connect" ? "mode-tab on" : "mode-tab"}
            aria-selected={mode === "connect"}
            onClick={() => choose("connect")}
          >
            Connect
          </button>
          <button
            type="button"
            className={mode === "watch" ? "mode-tab on" : "mode-tab"}
            aria-selected={mode === "watch"}
            onClick={() => choose("watch")}
          >
            Watch
          </button>
        </nav>
      </header>

      {mode === "connect" ? (
        <ConnectLanding onWatch={() => choose("watch")} />
      ) : (
        <CityApp {...props} embedded />
      )}
    </div>
  );
}
