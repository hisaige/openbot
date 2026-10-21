// Browser entry (index.html → this file). The whole app shares one atom registry; every
// @openbot/client atom (RPC runtime, roster, conversations, commands) lives in it.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RegistryProvider } from "@effect/atom-react"
import { Toaster } from "@openbot/ui"
import { App } from "./app/App.tsx"
import { desktopApp } from "./app/notifications.ts"
import { QuickSend } from "./quick/QuickSend.tsx"
import { enableMarkdownParseStats, markdownParseStats, resetMarkdownParseStats } from "./chat/Markdown.tsx"

declare global {
  interface Window {
    /** The parse counters (US-6's criterion). Counts only — never the text. */
    __obMarkdownParseStats: () => { readonly parses: number; readonly changedBodies: number; readonly unchangedBodies: number }
    /** Clears the counters. The per-body text memory survives. */
    __obResetMarkdownParseStats: () => void
  }
}
const root = document.getElementById("root")
if (!root) throw new Error("#root missing from index.html")

// The parse counter (US-6) is OFF by default: the app's normal path pays one branch and nothing
// else. It is turned on by a flag instead of by an API call, because it has to be on from the
// VERY FIRST render — the counter attributes a re-parse to "the same text as last time", and the
// per-body memory is filled by the first render. Enabling it later would make every body look
// like a first parse, and the baseline measurement (unchangedBodies ≈ K-1) would come out as 0 —
// a false pass.
//
// The flag is a `sessionStorage` key, NOT a URL parameter: the app rewrites the hash on every
// route change (`uiState.ts`'s `select` replaces it with `#/c/<id>`), so a query parameter put
// after the hash would be dropped before the app ever read it. `sessionStorage` survives the
// navigation (it is per-tab) and is readable synchronously before the first render.
const PARSE_STATS_KEY = "obParseStats"
if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(PARSE_STATS_KEY) === "1") {
  enableMarkdownParseStats()
}

// In the desktop app (apps/desktop): `data-desktop` = its platform. On macOS the window has no title
// bar: a strip along the top moves it (app.css `.ob-titlebar`), first in the page so the buttons
// and fields after it stay clickable.
const desktop = desktopApp()
if (desktop !== undefined) document.documentElement.dataset.desktop = desktop.platform

// `#/quick-send`: only the quick send card (the desktop app's floating panel, or the bookmarklet's
// popup), not the app; in the panel the page around the card is transparent.
const quickSend = location.hash.startsWith("#/quick-send")
if (quickSend) document.documentElement.dataset.quickSend = desktop?.quickSend !== undefined ? "panel" : "page"

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <Toaster>
        {quickSend ? (
          <QuickSend />
        ) : (
          <>
            {desktop?.platform === "darwin" && <div aria-hidden className="ob-titlebar" />}
            <App />
          </>
        )}
      </Toaster>
    </RegistryProvider>
  </StrictMode>,
)

// The parse counters (US-6): the measurement hook the diagnostic e2e reads. The counter itself is
// off until someone turns it on, so the app's normal path pays one branch and nothing else.
window.__obMarkdownParseStats = markdownParseStats
window.__obResetMarkdownParseStats = resetMarkdownParseStats
