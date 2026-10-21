import { describe, expect, test } from "bun:test"
import { ConfigError, DEFAULT_HARNESSES, defaultDataDir, normalizeOrigin, parseCommand, resolvePath } from "../src/config.ts"
import { originsFor } from "../src/listeners.ts"

const system = { home: "/home/u", cwd: "/work/repo" }
const run = (argv: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const parsed = parseCommand(argv, env, system)
  if (parsed._tag !== "Run") throw new Error(`expected Run, got ${parsed._tag}`)
  return parsed.config
}

describe("parseCommand", () => {
  test("defaults", () => {
    expect(run([])).toEqual({
      dataDir: "/home/u/.local/share/openbot",
      port: 7420,
      host: "127.0.0.1",
      publicOrigins: [],
      localNode: true,
      dev: false,
      harnesses: DEFAULT_HARNESSES,
      claudePath: undefined,
    })
    expect(run([], { XDG_DATA_HOME: "/xdg/data/" }).dataDir).toBe("/xdg/data/openbot")
  })

  test("flags (both --flag value and --flag=value)", () => {
    const config = run([
      "--data-dir",
      "./data",
      "--port=0",
      "--host",
      "0.0.0.0",
      "--public-origin",
      "https://Box.tailnet.ts.net/",
      "--public-origin=box.lan:8443",
      "--no-local-node",
      "--dev",
      "--harness",
      "claude,codex",
      "--claude-path",
      "~/bin/claude",
    ])
    expect(config).toEqual({
      dataDir: "/work/repo/data",
      port: 0,
      host: "0.0.0.0",
      publicOrigins: ["https://box.tailnet.ts.net", "https://box.lan:8443"],
      localNode: false,
      dev: true,
      harnesses: ["fake", "claude", "codex"],
      claudePath: "/home/u/bin/claude",
    })
  })

  test("OPENBOT_* environment, and the CLI wins over it", () => {
    const env = {
      OPENBOT_DATA_DIR: "/srv/openbot",
      OPENBOT_PORT: "9000",
      OPENBOT_HOST: "::",
      OPENBOT_PUBLIC_ORIGIN: "https://a.example, https://b.example",
      OPENBOT_LOCAL_NODE: "0",
      OPENBOT_DEV: "true",
      OPENBOT_HARNESSES: "opencode",
      OPENBOT_CLAUDE_PATH: "/opt/claude",
    }
    expect(run([], env)).toEqual({
      dataDir: "/srv/openbot",
      port: 9000,
      host: "::",
      publicOrigins: ["https://a.example", "https://b.example"],
      localNode: false,
      dev: true,
      harnesses: ["fake", "opencode"],
      claudePath: "/opt/claude",
    })
    expect(run(["--port", "7000", "--local-node", "--harness", "all"], env)).toMatchObject({
      port: 7000,
      localNode: true,
      harnesses: ["fake", "claude", "codex", "opencode"],
    })
    expect(run(["--claude-path", "bundled"], env).claudePath).toBeUndefined()
    // send_file cap: CLI beats env; absent = core's default
    expect(run([], env).maxFileBytes).toBeUndefined()
    expect(run([], { ...env, OPENBOT_MAX_FILE_MB: "50" }).maxFileBytes).toBe(50_000_000)
    expect(run(["--max-file-mb", "1024"], { ...env, OPENBOT_MAX_FILE_MB: "50" }).maxFileBytes).toBe(1_024_000_000)
    expect(run(["--desktop-idle", "0"], { ...env, OPENBOT_DESKTOP_IDLE_MINUTES: "5" }).desktopIdleMs).toBe(0)
    expect(run([], { ...env, OPENBOT_DESKTOP_IDLE_MINUTES: "2.5" }).desktopIdleMs).toBe(150_000)
    expect(run([], env).desktopIdleMs).toBeUndefined()
    // skills.sh base URL (env only; tests point it at a fake)
    expect(run([], env).skillsShUrl).toBeUndefined()
    expect(run([], { OPENBOT_SKILLS_SH_URL: "http://127.0.0.1:4000/" }).skillsShUrl).toBe("http://127.0.0.1:4000")
    expect(() => run([], { OPENBOT_SKILLS_SH_URL: "skills.example" })).toThrow("not an http(s) URL")
  })

  /**
   * The publish window's K (product spec v2 §2.8 C-3). `1` switches the window off — the
   * "unmerged control" path E-5 depends on — and a window that is on must use K = 4..5.
   *
   * The rejected values are not arbitrary: K=2 and K=3 break the US-7 clause 2 criterion
   * `A <= floor((N+1)/3)` (K=3 from N=21 on, K=2 earlier), so accepting them would let a tuning
   * run silently invalidate the criterion while every test still passes — they only ever
   * exercise K=4. This test is the only thing standing between a typo and a broken criterion.
   */
  test("the publish window's K: 1 (off) or 4..5 — nothing in between", () => {
    // The window off: the unmerged control path (E-5).
    expect(run([], { OPENBOT_STREAM_WINDOW_MAX_PENDING: "1" }).streamWindowMaxPending).toBe(1)
    // The allowed window values.
    expect(run([], { OPENBOT_STREAM_WINDOW_MAX_PENDING: "4" }).streamWindowMaxPending).toBe(4)
    expect(run([], { OPENBOT_STREAM_WINDOW_MAX_PENDING: "5" }).streamWindowMaxPending).toBe(5)
    // Absent = the default (K=4).
    expect(run([], {}).streamWindowMaxPending).toBeUndefined()
    // The values that break the criterion, and everything else outside 1 / 4..5.
    for (const bad of ["2", "3", "0", "6", "-1", "1.5", "abc", "NaN", "1e9"]) {
      expect(() => run([], { OPENBOT_STREAM_WINDOW_MAX_PENDING: bad })).toThrow(ConfigError)
    }
    // The stall fallback keeps its own range.
    expect(run([], { OPENBOT_STREAM_WINDOW_STALL_MS: "1000" }).streamWindowStallMs).toBe(1000)
    expect(run([], { OPENBOT_STREAM_WINDOW_STALL_MS: "5000" }).streamWindowStallMs).toBe(5000)
    for (const bad of ["999", "5001", "0", "abc"]) {
      expect(() => run([], { OPENBOT_STREAM_WINDOW_STALL_MS: bad })).toThrow(ConfigError)
    }
  })

  test("help, version and errors", () => {
    expect(parseCommand(["--help"], {}, system)._tag).toBe("Help")
    expect(parseCommand(["-v"], {}, system)._tag).toBe("Version")
    expect(() => parseCommand(["--nope"], {}, system)).toThrow(ConfigError)
    expect(() => parseCommand(["--port"], {}, system)).toThrow("--port needs a value")
    expect(() => parseCommand(["--port", "70000"], {}, system)).toThrow("out of range")
    expect(() => parseCommand(["--port", "abc"], {}, system)).toThrow("not a port")
    expect(() => parseCommand(["--harness", "gemini"], {}, system)).toThrow("unknown harness")
    expect(() => parseCommand(["--public-origin", "ftp://x"], {}, system)).toThrow("http(s)")
    expect(() => parseCommand(["--max-file-mb", "0"], {}, system)).toThrow("not a size in MB")
    expect(() => parseCommand(["--max-file-mb", "lots"], {}, system)).toThrow("not a size in MB")
    expect(() => parseCommand(["--desktop-idle", "-1"], {}, system)).toThrow("not a number of minutes")
    expect(() => parseCommand(["--desktop-idle", "soon"], {}, system)).toThrow("not a number of minutes")
  })
})

describe("helpers", () => {
  test("resolvePath / defaultDataDir / normalizeOrigin", () => {
    expect(resolvePath("~", "/h", "/c")).toBe("/h")
    expect(resolvePath("a/../b/./c/", "/h", "/c")).toBe("/c/b/c")
    expect(resolvePath("/x//y/", "/h", "/c")).toBe("/x/y")
    expect(defaultDataDir({ XDG_DATA_HOME: "relative" }, "/h")).toBe("/h/.local/share/openbot")
    expect(normalizeOrigin("http://127.0.0.1:7420/path?q")).toBe("http://127.0.0.1:7420")
  })

  test("origins: loopback binds get 127.0.0.1 + localhost; the first public origin is canonical for nodes", () => {
    expect(originsFor({ host: "127.0.0.1", port: 7420, publicOrigins: [] })).toEqual({
      selfBase: "http://127.0.0.1:7420",
      loginBase: "http://127.0.0.1:7420",
      brainOrigin: "http://127.0.0.1:7420",
      allowedOrigins: ["http://127.0.0.1:7420", "http://localhost:7420"],
    })
    const lan = originsFor({ host: "192.168.1.5", port: 80, publicOrigins: ["https://box.ts.net"] })
    expect(lan.brainOrigin).toBe("https://box.ts.net")
    expect(lan.selfBase).toBe("http://192.168.1.5:80")
    expect(lan.allowedOrigins).toEqual(["https://box.ts.net", "http://127.0.0.1:80", "http://localhost:80", "http://192.168.1.5:80"])
    expect(originsFor({ host: "0.0.0.0", port: 1, publicOrigins: [] }).selfBase).toBe("http://127.0.0.1:1")
  })
})
