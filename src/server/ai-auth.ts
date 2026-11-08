import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  MAX_AI_PROVIDER_CHARS,
  type AiCredentialKind,
  type AiLoginEvent,
} from "../shared/contracts";
import type { AiManager } from "./ai-settings";
import { applyDataHeaders, HttpError, readJson } from "./http";

const LOGIN_DEADLINE_MS = 10 * 60_000;
const HEARTBEAT_MS = 20_000;
const MAX_LOGIN_BYTES = 16 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_ANSWER_VALUE_CHARS = 8192;
const MAX_PROMPT_ID_CHARS = 256;

const encoder = new TextEncoder();

export class AiLoginBusyError extends Error {
  constructor() {
    super("another AI sign-in is already in progress");
    this.name = "AiLoginBusyError";
  }
}

export class AiLoginStoppingError extends Error {
  constructor() {
    super("the server is shutting down");
    this.name = "AiLoginStoppingError";
  }
}

export class AiLoginNotFoundError extends Error {
  constructor() {
    super("AI sign-in session does not exist");
    this.name = "AiLoginNotFoundError";
  }
}

export class AiLoginStalePromptError extends Error {
  constructor() {
    super("this AI sign-in prompt is no longer active");
    this.name = "AiLoginStalePromptError";
  }
}

export class AiLoginValueError extends Error {
  constructor(message = "invalid answer for this AI sign-in prompt") {
    super(message);
    this.name = "AiLoginValueError";
  }
}

const loginStartSchema = z.strictObject({
  provider: z.string().min(1).max(MAX_AI_PROVIDER_CHARS),
  type: z.enum(["api_key", "oauth"]),
});
const answerSchema = z.strictObject({
  promptId: z.string().min(1).max(MAX_PROMPT_ID_CHARS),
  value: z.string().max(MAX_ANSWER_VALUE_CHARS),
});

function methodNotAllowed(): never {
  throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
}

function noContent(): Response {
  const response = new Response(null, { status: 204 });
  applyDataHeaders(response);
  return response;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "path contains invalid encoding");
  }
}

function promptEvent(promptId: string, prompt: AuthPrompt): AiLoginEvent {
  switch (prompt.type) {
    case "text":
      return {
        type: "prompt",
        promptId,
        prompt: {
          type: "text",
          message: prompt.message,
          ...(prompt.placeholder === undefined
            ? {}
            : { placeholder: prompt.placeholder }),
        },
      };
    case "secret":
      return {
        type: "prompt",
        promptId,
        prompt: {
          type: "secret",
          message: prompt.message,
          ...(prompt.placeholder === undefined
            ? {}
            : { placeholder: prompt.placeholder }),
        },
      };
    case "select":
      return {
        type: "prompt",
        promptId,
        prompt: {
          type: "select",
          message: prompt.message,
          options: prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description === undefined
              ? {}
              : { description: option.description }),
          })),
        },
      };
    case "manual_code":
      return {
        type: "prompt",
        promptId,
        prompt: {
          type: "manual_code",
          message: prompt.message,
          ...(prompt.placeholder === undefined
            ? {}
            : { placeholder: prompt.placeholder }),
        },
      };
  }
}

function notificationEvent(event: AuthEvent): AiLoginEvent {
  switch (event.type) {
    case "info":
      return {
        type: "notification",
        event: {
          type: "info",
          message: event.message,
          ...(event.links === undefined
            ? {}
            : {
                links: event.links.map((link) => ({
                  url: link.url,
                  ...(link.label === undefined ? {} : { label: link.label }),
                })),
              }),
        },
      };
    case "auth_url":
      return {
        type: "notification",
        event: {
          type: "auth_url",
          url: event.url,
          ...(event.instructions === undefined
            ? {}
            : { instructions: event.instructions }),
        },
      };
    case "device_code":
      return {
        type: "notification",
        event: {
          type: "device_code",
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.intervalSeconds === undefined
            ? {}
            : { intervalSeconds: event.intervalSeconds }),
          ...(event.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: event.expiresInSeconds }),
        },
      };
    case "progress":
      return { type: "notification", event: { type: "progress", message: event.message } };
  }
}

interface PendingPrompt {
  settled: boolean;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  selectIds?: readonly string[];
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

class LoginSession {
  readonly id = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly #pending = new Map<string, PendingPrompt>();
  readonly #ai: AiManager;
  readonly #deadlineMs: number;
  readonly #settled: Promise<void>;
  #resolveSettled!: () => void;
  #emit: ((event: AiLoginEvent) => void) | null = null;
  #sendRaw: ((text: string) => void) | null = null;
  #close: (() => void) | null = null;
  #closed = false;
  #reason: "expired" | "cancelled" | null = null;
  #promptCounter = 0;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly provider: string,
    readonly type: AiCredentialKind,
    ai: AiManager,
    deadlineMs: number,
  ) {
    this.#ai = ai;
    this.#deadlineMs = deadlineMs;
    this.#settled = new Promise((resolve) => {
      this.#resolveSettled = resolve;
    });
    this.controller.signal.addEventListener(
      "abort",
      () => this.#rejectPending(abortReason(this.controller.signal)),
      { once: true },
    );
  }

  get settled(): Promise<void> {
    return this.#settled;
  }

  attach(
    emit: (event: AiLoginEvent) => void,
    sendRaw: (text: string) => void,
    close: () => void,
  ): void {
    this.#emit = emit;
    this.#sendRaw = sendRaw;
    this.#close = close;
    this.#deadline = setTimeout(() => {
      this.#expire();
    }, this.#deadlineMs);
    this.#heartbeat = setInterval(() => {
      if (!this.#closed) this.#raw("\n");
    }, HEARTBEAT_MS);
  }

  async run(): Promise<void> {
    this.#emitEvent({ type: "session", sessionId: this.id });
    try {
      await this.#ai.login(this.provider, this.type, {
        signal: this.controller.signal,
        prompt: (prompt) => this.#prompt(prompt),
        notify: (event) => this.#emitEvent(notificationEvent(event)),
      });
      // Pi persisted the credential before login resolved, even if a cancel
      // raced the commit. Report the authoritative stored state.
      this.#emitEvent({
        type: "done",
        provider: this.provider,
        credentialType: this.type,
      });
    } catch (error) {
      if (!this.#closed) {
        if (this.#reason === "expired") {
          this.#emitEvent({
            type: "error",
            error: {
              code: "AI_LOGIN_EXPIRED",
              message: "sign-in expired; start again",
            },
          });
        } else if (this.#reason === "cancelled" || this.controller.signal.aborted) {
          this.#emitEvent({ type: "cancelled" });
        } else {
          console.error(
            `AI login failed (${this.provider}/${this.type}) code=login`,
          );
          this.#emitEvent({
            type: "error",
            error: {
              code: "AI_LOGIN_FAILED",
              message: "provider sign-in failed; review its instructions and retry",
            },
          });
        }
      }
    } finally {
      this.#finish();
    }
  }

  answer(promptId: string, value: string): void {
    if (this.#closed) throw new AiLoginNotFoundError();
    const pending = this.#pending.get(promptId);
    if (!pending || pending.settled) throw new AiLoginStalePromptError();
    if (pending.selectIds && !pending.selectIds.includes(value)) {
      throw new AiLoginValueError("select one of the offered options");
    }
    pending.settled = true;
    this.#pending.delete(promptId);
    pending.cleanup();
    pending.resolve(value);
  }

  cancel(reason: "cancelled" | "expired" = "cancelled"): void {
    if (this.#closed) return;
    this.#reason ??= reason;
    this.controller.abort(new DOMException("cancelled", "AbortError"));
  }

  #prompt(prompt: AuthPrompt): Promise<string> {
    if (this.#closed || this.controller.signal.aborted) {
      return Promise.reject(
        abortReason(this.controller.signal),
      );
    }
    return new Promise((resolve, reject) => {
      const promptId = `prompt-${++this.#promptCounter}`;
      let cleanup = (): void => {};
      const pending: PendingPrompt = {
        settled: false,
        resolve,
        reject,
        cleanup: () => cleanup(),
        ...(prompt.type === "select"
          ? { selectIds: prompt.options.map((option) => option.id) }
          : {}),
      };
      this.#pending.set(promptId, pending);

      const signal = prompt.signal;
      if (signal) {
        const onAbort = (): void => {
          if (pending.settled) return;
          pending.settled = true;
          this.#pending.delete(promptId);
          cleanup();
          this.#emitEvent({ type: "prompt_cancelled", promptId });
          reject(abortReason(signal));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.#emitEvent(promptEvent(promptId, prompt));
    });
  }

  #rejectPending(reason: unknown): void {
    for (const [promptId, pending] of this.#pending) {
      if (pending.settled) continue;
      pending.settled = true;
      this.#pending.delete(promptId);
      pending.cleanup();
      pending.reject(reason);
    }
  }

  #expire(): void {
    if (this.#closed) return;
    this.#reason = "expired";
    this.controller.abort(new DOMException("expired", "AbortError"));
  }

  #emitEvent(event: AiLoginEvent): void {
    if (this.#closed) return;
    try {
      this.#emit?.(event);
    } catch {
      this.#closed = true;
      this.controller.abort(new DOMException("cancelled", "AbortError"));
    }
  }

  #raw(text: string): void {
    if (this.#closed) return;
    try {
      this.#sendRaw?.(text);
    } catch {
      this.#closed = true;
      this.controller.abort(new DOMException("cancelled", "AbortError"));
    }
  }

  #finish(): void {
    // A disconnected browser sets #closed before the run ends; timers must still stop.
    this.#closed = true;
    clearTimeout(this.#deadline);
    clearInterval(this.#heartbeat);
    this.#deadline = undefined;
    this.#heartbeat = undefined;
    this.#rejectPending(new DOMException("cancelled", "AbortError"));
    try {
      this.#close?.();
    } catch {
      // The browser may have disconnected already.
    }
    this.#resolveSettled();
  }
}

export interface LoginRegistry {
  start(
    provider: string,
    type: AiCredentialKind,
    ai: AiManager,
  ): Promise<Response>;
  answer(sessionId: string, promptId: string, value: string): void;
  cancel(sessionId: string): void;
  cancelProvider(provider: string): Promise<void>;
  /** Refuses new sign-ins, cancels the active one and resolves once it has settled. */
  shutdown(): Promise<void>;
}

export function createLoginRegistry(
  options: { deadlineMs?: number } = {},
): LoginRegistry {
  let active: LoginSession | null = null;
  let stopping = false;
  const deadlineMs = options.deadlineMs ?? LOGIN_DEADLINE_MS;

  return {
    async start(provider, type, ai) {
      if (stopping) throw new AiLoginStoppingError();
      if (active) throw new AiLoginBusyError();
      await ai.assertLoginSupported(provider, type);
      if (stopping) throw new AiLoginStoppingError();
      if (active) throw new AiLoginBusyError();

      const session = new LoginSession(provider, type, ai, deadlineMs);
      active = session;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          session.attach(
            (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
            (text) => controller.enqueue(encoder.encode(text)),
            () => controller.close(),
          );
          void session.run().finally(() => {
            if (active === session) active = null;
          });
        },
        cancel() {
          session.cancel("cancelled");
        },
      });
      const response = new Response(stream, {
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      });
      applyDataHeaders(response);
      return response;
    },
    answer(sessionId, promptId, value) {
      if (!active || active.id !== sessionId) throw new AiLoginNotFoundError();
      active.answer(promptId, value);
    },
    cancel(sessionId) {
      if (!active || active.id !== sessionId) throw new AiLoginNotFoundError();
      active.cancel("cancelled");
    },
    async cancelProvider(provider) {
      if (!active || active.provider !== provider) return;
      const session = active;
      session.cancel("cancelled");
      await session.settled;
    },
    async shutdown() {
      stopping = true;
      const session = active;
      if (!session) return;
      session.cancel("cancelled");
      await session.settled;
    },
  };
}

export async function handleAiAuth(
  request: Request,
  url: URL,
  ctx: { ai: AiManager; logins: LoginRegistry },
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/ai/login") {
    if (method !== "POST") methodNotAllowed();
    const body = await readJson(request, MAX_LOGIN_BYTES, loginStartSchema);
    return ctx.logins.start(body.provider, body.type, ctx.ai);
  }

  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "ai" &&
    segments[2] === "login"
  ) {
    const sessionId = safeDecode(segments[3]!);
    if (segments[4] === "answer") {
      if (method !== "POST") methodNotAllowed();
      const body = await readJson(request, MAX_ANSWER_BYTES, answerSchema);
      ctx.logins.answer(sessionId, body.promptId, body.value);
      return noContent();
    }
    if (segments[4] === "cancel") {
      if (method !== "POST") methodNotAllowed();
      ctx.logins.cancel(sessionId);
      return noContent();
    }
  }

  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "ai" &&
    segments[2] === "credentials"
  ) {
    if (method !== "DELETE") methodNotAllowed();
    const provider = safeDecode(segments[3]!);
    await ctx.logins.cancelProvider(provider);
    await ctx.ai.logout(provider);
    return noContent();
  }

  return null;
}
