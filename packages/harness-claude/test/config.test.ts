import { describe, expect, test } from "bun:test"
import { cleanEnv, INHERITED_CLAUDE_CODE_VARS } from "../src/config.ts"

describe("Claude CLI environment", () => {
  test("keeps credentials, backend choice and config dir", () => {
    const env = cleanEnv({
      ANTHROPIC_AUTH_TOKEN: "token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "ttsw-cc-main[1M]",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_GIT_BASH_PATH: "C:/git",
      CLAUDE_CONFIG_DIR: "/root/.claude-2",
      PATH: "/usr/bin",
    })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("token")
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:15721")
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("ttsw-cc-main[1M]")
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth")
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1")
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe("C:/git")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/root/.claude-2")
    expect(env.PATH).toBe("/usr/bin")
  })

  test("keeps the model configuration a bot is meant to follow", () => {
    const base = Object.fromEntries(INHERITED_CLAUDE_CODE_VARS.map((key) => [key, `value-of-${key}`]))
    const env = cleanEnv(base)
    for (const key of INHERITED_CLAUDE_CODE_VARS) expect(env[key]).toBe(`value-of-${key}`)
  })

  test("drops the parent session's identity and hooks", () => {
    const env = cleanEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "c0944aa7",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/0/cc-socks/1.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "secret",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
      CLAUDE_AGENT_SDK_VERSION: "0.3.300",
      CLAUDE_AGENT_SDK_CLIENT_APP: "claude-code/2.1.300",
      KEEP_ME: "1",
    })
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_SESSION_ATTENDED",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_AGENT_SDK_VERSION",
    ]) expect(env[key]).toBeUndefined()
    expect(env.KEEP_ME).toBe("1")
    // The SDK's own identity is always stamped, never inherited.
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("openbot/0.0.0")
  })

  test("ends with the isolation switches and lets `extra` win", () => {
    const env = cleanEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "true", A: "inherited" }, { A: "extra" }, "client/9")
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
    expect(env.A).toBe("extra")
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("client/9")
  })
})
