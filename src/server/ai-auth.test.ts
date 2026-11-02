import { describe, expect, test } from "bun:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  aiLoginEventSchema,
  type AiCredentialKind,
  type AiLoginEvent,
} from "../shared/contracts";
import {
  createLoginRegistry,
  handleAiAuth,
  type LoginRegistry,
} from "./ai-auth";
import type { AiManager } from "./ai-settings";
import { httpErrorFromUnknown } from "./http";

const origin = "http://127.0.0.1:1234";

function fakeManager(
  login: (interaction: AuthInteraction) => Promise<void>,
  hooks: { logout?: () => void } = {},
): AiManager {
  return {
    assertLoginSupported: async () => undefined,
    login: (
      _provider: string,
      _type: AiCredentialKind,
      interaction: AuthInteraction,
    ) => login(interaction),
    logout: async () => {
      hooks.logout?.();
    },
  } as unknown as AiManager;
}

function start(
  logins: LoginRegistry,
  ai: AiManager,
  provider = "openai",
  type: "api_key" | "oauth" = "api_key",
): Promise<Response> {
  return logins.start(provider, type, ai);
}

function answer(
  logins: LoginRegistry,
  ai: AiManager,
  sessionId: string,
  promptId: string,
  value: string,
): Promise<Response> {
  const path = `/api/ai/login/${encodeURIComponent(sessionId)}/answer`;
  return handleAiAuth(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promptId, value }),
    }),
    new URL(`${origin}${path}`),
    { ai, logins },
  ) as Promise<Response>;
}

function cancelProvider(
  logins: LoginRegistry,
  ai: AiManager,
  provider: string,
): Promise<Response> {
  const path = `/api/ai/credentials/${encodeURIComponent(provider)}`;
  return handleAiAuth(
    new Request(`${origin}${path}`, { method: "DELETE" }),
    new URL(`${origin}${path}`),
    { ai, logins },
  ) as Promise<Response>;
}

async function failure(response: Promise<unknown>): Promise<Response> {
  try {
    await response;
  } catch (error) {
    return httpErrorFromUnknown(error);
  }
  throw new Error("expected the request to fail");
}

class EventReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(response: Response) {
    this.#reader = response.body!.getReader();
  }

  async next(): Promise<AiLoginEvent> {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        return aiLoginEventSchema.parse(JSON.parse(line));
      }
      const { value, done } = await this.#reader.read();
      if (done) throw new Error("login stream ended without a terminal event");
      this.#buffer += this.#decoder.decode(value, { stream: true });
    }
  }

  cancel(): Promise<void> {
    return this.#reader.cancel();
  }
}

describe("AI login transport", () => {
  test("streams every prompt kind, notifications and done without echoing secrets", async () => {
    const logins = createLoginRegistry();
    const ai = fakeManager(async (interaction) => {
      interaction.notify({ type: "info", message: "Start sign-in" });
      const account = await interaction.prompt({ type: "text", message: "Account" });
      const choice = await interaction.prompt({
        type: "select",
        message: "Choose",
        options: [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ],
      });
      const code = await interaction.prompt({ type: "manual_code", message: "Code" });
      const secret = await interaction.prompt({ type: "secret", message: "Key" });
      interaction.notify({
        type: "progress",
        message: `${account}/${choice}/${code}/${secret.length}`,
      });
    });

    const response = await start(logins, ai);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events: AiLoginEvent[] = [];
    const stream = new EventReader(response);
    const answers: Record<string, string> = {
      text: "person@example.com",
      select: "two",
      manual_code: "123456",
      secret: "super-secret",
    };
    let sessionId = "";
    for (;;) {
      const event = await stream.next();
      events.push(event);
      if (event.type === "session") sessionId = event.sessionId;
      if (event.type === "prompt") {
        const value = answers[event.prompt.type];
        if (value === undefined) throw new Error("missing test answer");
        const saved = await answer(
          logins,
          ai,
          sessionId,
          event.promptId,
          value,
        );
        expect(saved.status).toBe(204);
      }
      if (event.type === "done" || event.type === "error") break;
    }

    expect(events.map((event) => event.type)).toEqual([
      "session",
      "notification",
      "prompt",
      "prompt",
      "prompt",
      "prompt",
      "notification",
      "done",
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      provider: "openai",
      credentialType: "api_key",
    });
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  test("rejects invalid select values, duplicate answers and unknown sessions", async () => {
    const logins = createLoginRegistry();
    let releaseDone!: () => void;
    const doneGate = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    const ai = fakeManager(async (interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Choose",
        options: [{ id: "one", label: "One" }],
      });
      await doneGate;
    });
    const stream = new EventReader(await start(logins, ai));
    const session = await stream.next();
    expect(session.type).toBe("session");
    const prompt = await stream.next();
    expect(prompt.type).toBe("prompt");
    if (session.type !== "session" || prompt.type !== "prompt") throw new Error("bad stream");

    const invalid = await failure(
      answer(logins, ai, session.sessionId, prompt.promptId, "offered"),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    expect(
      (await answer(logins, ai, session.sessionId, prompt.promptId, "one")).status,
    ).toBe(204);
    const stale = await failure(
      answer(logins, ai, session.sessionId, prompt.promptId, "one"),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "AI_LOGIN_STALE_PROMPT" },
    });
    const missing = await failure(answer(logins, ai, "missing", prompt.promptId, "one"));
    expect(missing.status).toBe(404);
    releaseDone();
    expect(await stream.next()).toMatchObject({ type: "done" });
  });

  test("emits done only after the provider resolves", async () => {
    const logins = createLoginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ai = fakeManager(async () => {
      await gate;
    });
    const stream = new EventReader(await start(logins, ai));
    expect(await stream.next()).toMatchObject({ type: "session" });
    const pending = stream.next();
    const early = await Promise.race([
      pending,
      Bun.sleep(30).then(() => "pending" as const),
    ]);
    expect(early).toBe("pending");
    release();
    expect(await pending).toMatchObject({ type: "done" });
  });

  test("deleting credentials cancels the active login before logging out", async () => {
    const logins = createLoginRegistry();
    const order: string[] = [];
    const ai = fakeManager(
      async (interaction) => {
        await interaction.prompt({ type: "secret", message: "Key" });
      },
      { logout: () => order.push("logout") },
    );
    const stream = new EventReader(await start(logins, ai));
    await stream.next();
    const prompt = await stream.next();
    expect(prompt.type).toBe("prompt");

    const response = await cancelProvider(logins, ai, "openai");
    expect(response.status).toBe(204);
    expect(order).toEqual(["logout"]);
    expect(await stream.next()).toEqual({ type: "cancelled" });
  });

  test("expires a login after its deadline", async () => {
    const logins = createLoginRegistry({ deadlineMs: 30 });
    const ai = fakeManager(async (interaction) => {
      await interaction.prompt({ type: "secret", message: "Key" });
    });
    const stream = new EventReader(await start(logins, ai));
    await stream.next();
    await stream.next();
    expect(await stream.next()).toEqual({
      type: "error",
      error: { code: "AI_LOGIN_EXPIRED", message: expect.any(String) },
    });
  });

  test("allows one login at a time and releases it when the client disconnects", async () => {
    const logins = createLoginRegistry();
    const ai = fakeManager(async (interaction) => {
      await interaction.prompt({ type: "secret", message: "Key" });
    }, {});
    const first = new EventReader(await start(logins, ai));
    const session = await first.next();
    expect(session.type).toBe("session");
    const busy = await failure(start(logins, ai));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "AI_LOGIN_BUSY" } });

    await first.cancel();
    await logins.cancelProvider("openai");
    const second = new EventReader(await start(logins, ai));
    expect(await second.next()).toMatchObject({ type: "session" });
  });
});
