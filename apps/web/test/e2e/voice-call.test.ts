// E2E (experiment): a voice call in Chromium against a brain with the real models. Chrome's fake
// microphone plays a WAV of Kokoro asking "Hey Otto, how's it going today?"; the call bar shows the
// call, the transcript shows what the brain heard and the Bot's answer. Needs voice input and an
// installed voice-calls folder (OPENBOT_LIVE_STT_DIR, OPENBOT_LIVE_VOICE_DIR). OPENBOT_LIVE_VOICE=1 to run.
// Screenshots: e2e-95-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import { symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Browser } from "playwright-core"
import { startSpeaker, voiceLayout } from "../../../server/src/voice/engine.ts"
import { VOICE_MANIFEST } from "../../../server/src/voice/manifest.ts"
import { IPHONE } from "../shoot-mobile.ts"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, startBrain } from "./brain.ts"

const LIVE = process.env["OPENBOT_LIVE_VOICE"] === "1"
const VOICE_DIR = process.env["OPENBOT_LIVE_VOICE_DIR"] ?? join(homedir(), ".cache", "openbot-live-voice")
const STT_DIR = process.env["OPENBOT_LIVE_STT_DIR"] ?? join(homedir(), ".local", "share", "openbot", "stt")

/** A mono 24 kHz PCM16 WAV: `lead` s of silence, the samples, then `tail` s of silence. */
const wav = (samples: Float32Array, lead: number, tail: number): Uint8Array => {
  const rate = 24_000
  const total = Math.round(rate * lead) + samples.length + Math.round(rate * tail)
  const out = new Uint8Array(44 + total * 2)
  const view = new DataView(out.buffer)
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, "RIFF")
  view.setUint32(4, 36 + total * 2, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, total * 2, true)
  const start = Math.round(rate * lead)
  samples.forEach((s, i) => view.setInt16(44 + (start + i) * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true))
  return out
}

describe.skipIf(!hasChromium || !LIVE)("e2e: a voice call with a Bot", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let otto: Bot

  beforeAll(async () => {
    const speaker = await startSpeaker({
      layout: voiceLayout(VOICE_DIR),
      manifest: VOICE_MANIFEST,
      sherpaLibDir: join(STT_DIR, "runtime", "lib"),
      startupTimeoutMs: 60_000,
      speakTimeoutMs: 30_000,
    })
    const question = await speaker.speak("Hey Otto, how's it going today?", 16)
    await speaker.stop()
    const microphone = join(tmpdir(), `openbot-e2e-voice-${process.pid}.wav`)
    writeFileSync(microphone, wav(question, 2, 40))
    brain = await startBrain({
      prepare: (dataDir) => {
        symlinkSync(STT_DIR, join(dataDir, "stt"))
        symlinkSync(VOICE_DIR, join(dataDir, "voice"))
      },
    })
    browser = await launchBrowser(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${microphone}`, "--autoplay-policy=no-user-gesture-required"])
    rpc = await connectRpc(brain)
    otto = await rpc.call((c) => c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-voice-otto", introduce: false }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${otto.directConversationId}` })
    await app.context.grantPermissions(["microphone"])
  }, 120_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("the call button starts a call; the Bot hears you and answers", async () => {
    const { page } = app
    page.on("pageerror", (error) => {
      const at = /\((http[^)]+\.js):(\d+):(\d+)\)/.exec(error.stack ?? "")
      if (at === null) return
      void fetch(at[1]!).then((r) => r.text()).then((js) => {
        const line = js.split("\n")[Number(at[2]) - 1] ?? ""
        console.log(`AT: ${line.slice(Number(at[3]) - 400, Number(at[3]) + 100)}`)
      })
    })
    await page.getByTestId("voice-call-button").click()
    const bar = page.getByTestId("call-bar")
    await bar.waitFor()
    await bar.getByRole("button", { name: "Show transcript" }).click()
    const transcript = page.getByTestId("call-transcript")
    const seen: Array<string> = []
    let lines: Array<string> = []
    for (let i = 0; i < 90 && !lines.some((l) => l.startsWith("Otto: ")); i++) {
      if ((await bar.count()) === 0) {
        seen.push("(no call bar)")
        break
      }
      seen.push(await page.getByTestId("call-phase").innerText().catch(() => "?"))
      lines = (await transcript.count()) > 0 ? await transcript.locator("p").allInnerTexts() : []
      await Bun.sleep(500)
    }
    console.log(`page errors: ${JSON.stringify(app.errors)}`)
    console.log(`phases: ${[...new Set(seen)].join(" → ")}\n${lines.join("\n")}`)
    console.log(brain.log().split("\n").filter((l) => /voice|rror|reply/i.test(l)).slice(-30).join("\n"))
    await app.shot("e2e-95-voice-call")
    // the Bot's voice: a preview, then another one chosen
    await bar.getByRole("button", { name: "Voice" }).click()
    const picker = page.getByTestId("voice-picker")
    await picker.getByRole("button", { name: "Hear Emma" }).click()
    await picker.getByRole("button", { name: "Hear Emma" }).waitFor()
    await picker.locator('[data-voice="bf_emma"]').click()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId: otto.id })), (b) => b.voice === "bf_emma", { label: "Emma chosen" })
    await app.shot("e2e-98-voice-picker")
    await bar.getByRole("button", { name: "Show transcript" }).click()
    expect(lines.some((l) => l.startsWith("You: ") && /going/i.test(l))).toBe(true)
    expect(lines.some((l) => l.startsWith("Otto: "))).toBe(true)
    await bar.getByRole("button", { name: "End call" }).click()
    await bar.waitFor({ state: "detached" })
    // the call stays in the chat as one line that opens to what was said
    const line = page.getByTestId("voice-chat-line")
    await line.waitFor({ timeout: 10_000 })
    expect(await line.innerText()).toMatch(/Voice chat · 00:\d\d/)
    await app.shot("e2e-96-voice-chat-line")
    await line.click()
    const opened = page.getByTestId("voice-chat")
    await opened.getByText("how's it going today?", { exact: false }).waitFor()
    await app.shot("e2e-97-voice-chat-opened")
    expect(app.errors).toEqual([])
  }, 120_000)

  test("on a phone the call bar fits the screen", async () => {
    const phone = await openApp(browser, brain, { theme: "dark", route: `#/c/${otto.directConversationId}`, context: IPHONE.options })
    await phone.context.grantPermissions(["microphone"])
    try {
      await phone.page.getByTestId("voice-call-button").click()
      const pill = phone.page.getByLabel("Call with Otto")
      await pill.waitFor()
      const box = (await pill.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(IPHONE.options.viewport!.width)
      await phone.shot("e2e-99-voice-call-phone")
      await phone.page.getByTestId("call-bar").getByRole("button", { name: "End call" }).click()
      expect(phone.errors).toEqual([])
    } finally {
      await phone.context.close()
    }
  }, 60_000)
})
