/**
 * HTTP routes of both listeners (architecture §4.9, hands-architecture-synthesis.md §S.6).
 *
 * Public:
 * - `GET /` (+ `?token=` login), `/index.html`, `/assets/*`: the web app behind the login page.
 * - `GET /rpc`: Effect RPC over WebSocket (`RpcSerialization.layerJson`), cookie + Origin or
 *   `?wsTicket=`; the socket closes when its session is logged out.
 * - `/api/auth/login` (GET `?token=` → cookie + redirect, POST → cookie), `POST /api/auth/logout`,
 *   `POST /api/auth/ws-ticket`, `GET /api/auth/status`; for the iPhone app `POST /api/auth/app-code`
 *   (signed in: a one-time code for its QR), `POST /api/auth/app-login` (`{code}` or `{token}` →
 *   `{sessionToken}`, sent back as `Authorization: Bearer`) and `POST /api/auth/web-code` (a 60 s code
 *   that signs its in-app web view in, `GET /api/auth/login?code=&next=`).
 * - `GET /api/attachments/:id` (cookie + Origin).
 * - `/ws/computer/:botId`, `/ws/terminal/:botId` (brain-nodes viewers, same auth as `/rpc`).
 * - `/ws/voice/:botId`: a voice call with a Bot (experiment; same auth as `/rpc`).
 * - `/node`, `POST /node/pair`, `/node/stream/:id` (brain-nodes; node signatures, codes, one-time tokens).
 *
 * Internal: `/mcp/:botId` (gateway, bearer only) and `/relay/:nodeId/:kind` (brain-nodes).
 *
 * Handlers close over their services at layer build time, so every route only needs the request.
 */
import { NodeInternalRoutes, NodePublicRoutes, ViewerRoutes } from "@openbot/brain-nodes"
import { DesktopRoutes } from "./desktop.ts"
import { type AttachmentId, OpenBotRpcs } from "@openbot/contracts"
import { AttachmentStore } from "@openbot/core"
import { McpGateway } from "@openbot/gateway"
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { WebAuth, searchParamsOf, sessionTokenOf } from "./auth.ts"
import { ServerConfig } from "./config.ts"
import { PublicListener } from "./listeners.ts"
import { VoiceCalls } from "./voice/service.ts"
import { loginPage, makeWebApp, PAGE_HEADERS, STATIC_PAGE_CSP, unavailablePage } from "./web.ts"

/** `HttpRouter.use`, spelled out (a layer that adds routes to the ambient router). */
const routes = <E, R>(
  add: (router: HttpRouter.HttpRouter) => Effect.Effect<void, E, R>,
) => Layer.effectDiscard(Effect.flatMap(HttpRouter.HttpRouter, add))

/** How long a desktop app's code waits to be allowed, and how many may wait at once. */
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000
const DEVICE_PENDING_MAX = 64
/** Letters and digits that cannot be mistaken for one another. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

/** `ABCD-EFGH` from 8 random bytes. */
export const userCodeOf = (bytes: Uint8Array): string => {
  const chars = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]!).join("")
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`
}

/** What the owner typed or the link carried, in `ABCD-EFGH` form. */
export const normalizeUserCode = (text: string): string => {
  const chars = text.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return chars.length === 8 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars
}

const randomToken = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store", ...headers },
  })

const refusal = (status: number, reason: string) =>
  HttpServerResponse.text(reason, { status, headers: { "cache-control": "no-store" } })

const htmlPage = (html: string, status: number, csp: string = STATIC_PAGE_CSP) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { ...PAGE_HEADERS, "content-security-policy": csp },
  })

// ============================================================================ /rpc

/**
 * `GET /rpc`: authenticate before upgrading, then hand the socket to one shared `RpcServer`
 * (`disableFatalDefects`: a handler defect never tears down other clients' requests). The socket is
 * closed (1001) when the session it was opened with logs out.
 */
export const RpcRoute = routes(Effect.fnUntraced(function*(router) {
  const auth = yield* WebAuth
  const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
  yield* Effect.forkScoped(
    RpcServer.make(OpenBotRpcs, { disableFatalDefects: true, disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
    ),
  )
  yield* router.add(
    "GET",
    "/rpc",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request, { allowTicket: true })
      if (!result.ok) return refusal(result.status, result.reason)
      return yield* Effect.raceFirst(
        httpEffect,
        Effect.as(auth.revoked(result.session), HttpServerResponse.empty()),
      )
    }),
  )
})).pipe(Layer.provide(RpcSerialization.layerJson))

// ============================================================================ /api/auth/*

const readToken = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const fromQuery = searchParamsOf(request).get("token")
    if (fromQuery !== null) return fromQuery
    if (request.method !== "POST") return undefined
    const body = yield* Effect.option(request.json)
    if (Option.isSome(body) && typeof body.value === "object" && body.value !== null) {
      const token = (body.value as Record<string, unknown>)["token"]
      if (typeof token === "string") return token
    }
    return undefined
  })

export const AuthRoutes = routes(Effect.fnUntraced(function*(router) {
  const auth = yield* WebAuth

  // GET: the printed link (`/?token=` does the same), or the iPhone app's web view (`?code=` from
  // `/api/auth/web-code`, `&next=#/…` the page to open); POST: programmatic clients.
  yield* router.add(
    "GET",
    "/api/auth/login",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const params = searchParamsOf(request)
      const webCode = params.get("code")
      if (webCode !== null) {
        const sessionToken = yield* auth.redeemWebCode(webCode)
        if (sessionToken === undefined) return htmlPage(loginPage({ error: "That link has expired. Open the page again from the app." }), 401)
        const next = params.get("next") ?? ""
        return HttpServerResponse.redirect(`/${/^#\/[\w/%?=.:-]*$/.test(next) ? next : ""}`, {
          status: 302,
          headers: { "set-cookie": auth.sessionCookie(request, sessionToken), "cache-control": "no-store" },
        })
      }
      const token = yield* readToken(request)
      const signedIn = token === undefined ? undefined : yield* auth.login(token)
      if (signedIn === undefined) {
        return htmlPage(loginPage({ error: token === undefined ? undefined : "That token is not valid." }), 401)
      }
      return HttpServerResponse.redirect("/", {
        status: 302,
        headers: { "set-cookie": auth.sessionCookie(request, signedIn.sessionToken), "cache-control": "no-store" },
      })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/login",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const refused = auth.checkOrigin(request)
      if (refused !== undefined) return json({ error: refused }, 403)
      const token = yield* readToken(request)
      const signedIn = token === undefined ? undefined : yield* auth.login(token)
      if (signedIn === undefined) return json({ error: "invalid token" }, 401)
      return json({ ok: true }, 200, { "set-cookie": auth.sessionCookie(request, signedIn.sessionToken) })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/logout",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const refused = auth.checkOrigin(request)
      if (refused !== undefined) return json({ error: refused }, 403)
      const token = sessionTokenOf(request)
      if (token !== undefined) yield* auth.logout(token)
      return HttpServerResponse.empty({
        status: 204,
        headers: { "set-cookie": auth.clearCookie(request), "cache-control": "no-store" },
      })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/ws-ticket",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request)
      if (!result.ok) return json({ error: result.reason }, result.status)
      return json(yield* auth.mintTicket(result.session))
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/app-code",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request)
      if (!result.ok) return json({ error: result.reason }, result.status)
      return json(yield* auth.mintAppCode(result.session), 200, { "cache-control": "no-store" })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/web-code",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request)
      const token = sessionTokenOf(request)
      if (!result.ok || token === undefined) return json({ error: result.ok ? "not signed in" : result.reason }, result.ok ? 401 : result.status)
      return json(yield* auth.mintWebCode(token), 200, { "cache-control": "no-store" })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/app-login",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* Effect.option(request.json)
      const field = (name: string) => {
        const value = Option.isSome(body) && typeof body.value === "object" && body.value !== null
          ? (body.value as Record<string, unknown>)[name]
          : undefined
        return typeof value === "string" && value.length <= 256 ? value : undefined
      }
      const code = field("code")
      const token = field("token")
      const signedIn = code !== undefined
        ? yield* auth.loginWithAppCode(code)
        : token !== undefined
        ? yield* auth.login(token)
        : undefined
      if (signedIn === undefined) return json({ error: code !== undefined ? "That code is not valid any more." : "That link is not valid." }, 401)
      return json({ sessionToken: signedIn.sessionToken }, 200, { "cache-control": "no-store" })
    }),
  )
  // Desktop app sign-in (device flow, apps/desktop): the app shows a code and opens the owner's
  // browser on `/#/connect-device?code=…`; the signed-in owner allows it there; the app's poll then
  // gets an app code (traded at `/api/auth/app-login` for a session of its own).
  const devices = new Map<string, { readonly userCode: string; readonly expiresAt: number; appCode?: string }>()
  const sweepDevices = (now: number) => {
    for (const [deviceCode, device] of devices) if (device.expiresAt <= now) devices.delete(deviceCode)
    while (devices.size >= DEVICE_PENDING_MAX) devices.delete(devices.keys().next().value!)
  }
  yield* router.add(
    "POST",
    "/api/auth/device/start",
    Effect.sync(() => {
      const now = Date.now()
      sweepDevices(now)
      const deviceCode = randomToken(32)
      const userCode = userCodeOf(crypto.getRandomValues(new Uint8Array(8)))
      devices.set(deviceCode, { userCode, expiresAt: now + DEVICE_CODE_TTL_MS })
      return json({ deviceCode, userCode, expiresInSeconds: DEVICE_CODE_TTL_MS / 1000, interval: 2 })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/device/poll",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* Effect.option(request.json)
      const deviceCode = Option.isSome(body) && typeof (body.value as { deviceCode?: unknown })?.deviceCode === "string"
        ? (body.value as { deviceCode: string }).deviceCode
        : ""
      const device = devices.get(deviceCode)
      if (device === undefined || device.expiresAt <= Date.now()) return json({ status: "expired" }, 410)
      if (device.appCode === undefined) return json({ status: "pending" })
      devices.delete(deviceCode)
      return json({ status: "approved", code: device.appCode })
    }),
  )
  yield* router.add(
    "POST",
    "/api/auth/device/approve",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request)
      if (!result.ok) return json({ error: result.reason }, result.status)
      const body = yield* Effect.option(request.json)
      const raw = Option.isSome(body) ? (body.value as { code?: unknown })?.code : undefined
      const userCode = typeof raw === "string" ? normalizeUserCode(raw) : ""
      const now = Date.now()
      const found = [...devices.values()].find((d) => d.userCode === userCode && d.expiresAt > now)
      if (found === undefined) return json({ error: "That code is not valid any more. Get a new one in the app." }, 404)
      found.appCode = (yield* auth.mintAppCode(result.session)).code
      return json({ ok: true })
    }),
  )
  yield* router.add(
    "GET",
    "/api/auth/status",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request)
      return json({ authenticated: result.ok })
    }),
  )
}))

// ============================================================================ /api/attachments/:id

/** Types a browser may render inline from our origin (everything else downloads). */
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/i
const SAFE_MIME = /^[\w.+-]+\/[\w.+-]+$/

const contentDisposition = (kind: "inline" | "attachment", name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file"
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * One `Range: bytes=…` (RFC 9110 §14.1.2) against a file of `size` bytes: `a-b`, `a-` or the
 * suffix `-n`. `undefined` = ignore the header (serve the whole file: not bytes, several ranges,
 * malformed); `"unsatisfiable"` = 416.
 */
export const parseByteRange = (
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | "unsatisfiable" | undefined => {
  if (header === undefined) return undefined
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (match === null) return undefined
  const [, from = "", to = ""] = match
  if (from === "" && to === "") return undefined
  if (from === "") {
    const suffix = Number(to)
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const last = to === "" ? undefined : Number(to)
  if (!Number.isSafeInteger(start) || (last !== undefined && (!Number.isSafeInteger(last) || last < start))) return undefined
  if (start >= size) return "unsatisfiable"
  return { start, end: last === undefined ? size - 1 : Math.min(last, size - 1) }
}

/**
 * `GET /api/attachments/:id` (and HEAD, which the router maps to GET): the owner's cookie + Origin;
 * the bytes stream from disk (`Bun.file`, never buffered); single byte ranges answer 206 (video
 * seeking, iOS Safari playback), unsatisfiable ones 416. Media, PDFs and plain text are `inline`,
 * everything else (and `?download=1`) an `attachment`. Never sniffed (`nosniff`); every type but PDF
 * runs in a CSP sandbox (Chrome's PDF viewer refuses sandboxed documents; a PDF cannot script our
 * origin anyway).
 */
export const AttachmentRoutes = routes(Effect.fnUntraced(function*(router) {
  const auth = yield* WebAuth
  const store = yield* AttachmentStore
  yield* router.add(
    "GET",
    "/api/attachments/:id",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request)
      if (!result.ok) return refusal(result.status, result.reason)
      const id = (yield* HttpRouter.params)["id"] ?? ""
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return refusal(404, "not found")
      const record = yield* Effect.orDie(store.get(id as AttachmentId))
      if (Option.isNone(record)) return refusal(404, "not found")
      const file = Bun.file(record.value.path)
      if (!(yield* Effect.promise(() => file.exists()))) return refusal(404, "not found")
      const size = file.size
      const mime = SAFE_MIME.test(record.value.mime) ? record.value.mime.toLowerCase() : "application/octet-stream"
      const download = searchParamsOf(request).get("download") === "1"
      const headers: Record<string, string> = {
        "content-type": mime,
        "content-disposition": contentDisposition(!download && INLINE_TYPES.test(mime) ? "inline" : "attachment", record.value.name),
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
        // uploaded content never runs as our origin (SVG/HTML scripts, plugins)
        "content-security-policy": mime === "application/pdf"
          ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"
          : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        "cache-control": "private, max-age=31536000, immutable",
      }
      const range = parseByteRange(request.headers["range"], size)
      if (range === "unsatisfiable") {
        return HttpServerResponse.empty({ status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
      }
      // content-length is explicit: a HEAD answer (the router runs this GET handler) has no body to measure
      if (range === undefined) return HttpServerResponse.raw(file, { status: 200, headers: { ...headers, "content-length": String(size) } })
      return HttpServerResponse.raw(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
          "content-length": String(range.end - range.start + 1),
        },
      })
    }),
  )
}))

// ============================================================================ web app

export const WebRoutes = routes(Effect.fnUntraced(function*(router) {
  const auth = yield* WebAuth
  const listener = yield* PublicListener
  const config = yield* ServerConfig
  const app = makeWebApp(listener.web, { dev: config.dev, selfBase: listener.selfBase })

  const page = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const token = searchParamsOf(request).get("token")
    if (token !== null) {
      // the printed link: exchange the token for a session, then drop it from the address bar
      const signedIn = yield* auth.login(token)
      if (signedIn === undefined) {
        return htmlPage(loginPage({ error: "That token is not valid." }), 401)
      }
      return HttpServerResponse.redirect("/", {
        status: 302,
        headers: { "set-cookie": auth.sessionCookie(request, signedIn.sessionToken), "cache-control": "no-store" },
      })
    }
    const session = yield* auth.session(sessionTokenOf(request))
    if (session === undefined) {
      return htmlPage(loginPage(), 401)
    }
    const result = yield* app.page
    if (!result.ok) {
      yield* Effect.logError(`Web app unavailable: ${result.detail}`)
      return htmlPage(unavailablePage(result.detail), 503)
    }
    return htmlPage(result.html, 200, "frame-ancestors 'none'")
  })
  yield* router.add("GET", "/", page)
  yield* router.add("GET", "/index.html", page)
  yield* router.add(
    "GET",
    "/assets/*",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://localhost").pathname
      const asset = yield* app.asset(path)
      if (asset === undefined) return refusal(404, "not found")
      return HttpServerResponse.raw(asset.body, {
        status: 200,
        headers: {
          "content-type": asset.type,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      })
    }),
  )
}))

// ============================================================================ viewers (brain-nodes)

/** `/ws/computer/:botId` and `/ws/terminal/:botId`: the same credentials as `/rpc`. Single owner: every bot. */
export const ViewerRoutesLive = ViewerRoutes((input) =>
  Effect.flatMap(WebAuth, (auth) =>
    Effect.map(auth.authenticate(input.request, { allowTicket: true }), (result) =>
      result.ok ? undefined : refusal(result.status, result.reason))
  )
)

// ============================================================================ composition

/** `/ws/voice/:botId`: a voice call (experiment), with the same credentials as `/rpc`. */
const VoiceRoute = routes(Effect.fnUntraced(function*(router) {
  const voice = yield* VoiceCalls
  const auth = yield* WebAuth
  yield* router.add(
    "GET",
    "/ws/voice/:botId",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* auth.authenticate(request, { allowTicket: true })
      if (!result.ok) return refusal(result.status, result.reason)
      const params = yield* HttpRouter.params
      return yield* voice.call(params["botId"] ?? "")
    }),
  )
}))

/** Every public route. */
export const PublicRoutes = Layer.mergeAll(RpcRoute, AuthRoutes, AttachmentRoutes, WebRoutes, ViewerRoutesLive, VoiceRoute, NodePublicRoutes, DesktopRoutes)

/** `/mcp/:botId` → `McpGateway.handle` (the gateway checks the bearer; cookies are ignored). */
export const McpRoute = routes(Effect.fnUntraced(function*(router) {
  const gateway = yield* McpGateway
  const handle = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const web = yield* Effect.orDie(HttpServerRequest.toWeb(request))
    const response = yield* Effect.promise(() => gateway.handle(web))
    return HttpServerResponse.raw(response, { status: response.status })
  })
  yield* router.add("*", "/mcp/:botId", handle)
}))

/** Every internal route. */
export const InternalRoutes = Layer.mergeAll(McpRoute, NodeInternalRoutes)
