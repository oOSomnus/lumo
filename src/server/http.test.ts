import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  assertContentEncoding,
  assertJsonContentType,
  classifyError,
  guardRequest,
  HttpError,
  parseJson,
  readBody,
} from "./http";
import { DocumentNotFoundError, PageOutOfRangeError } from "./storage";

const gate = {
  token: "secret-token",
  origin: "http://127.0.0.1:1234",
  host: "127.0.0.1:1234",
};

function request(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`${gate.origin}${path}`, {
    ...init,
    headers: {
      host: gate.host,
      authorization: `Bearer ${gate.token}`,
      ...headers,
    },
  });
}

// fetch Request headers strip Origin/Host, which browsers do send to the server.
function guardedRequest(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Request {
  return {
    url: `${gate.origin}${path}`,
    method,
    headers: new Headers({
      host: gate.host,
      authorization: `Bearer ${gate.token}`,
      ...headers,
    }),
  } as unknown as Request;
}

function streamRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): { request: Request; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    request: new Request(`${gate.origin}/api/translate`, {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit),
    cancelled: () => cancelled,
  };
}

describe("guardRequest", () => {
  test("accepts same-origin reads and writes with the bearer token", () => {
    expect(guardRequest(guardedRequest("/api/library"), gate)).toBeNull();
    expect(
      guardRequest(
        guardedRequest("/api/translate", "POST", {
          origin: gate.origin,
          "content-type": "application/json",
        }),
        gate,
      ),
    ).toBeNull();
  });

  test("rejects missing or wrong credentials", () => {
    const missing = guardedRequest("/api/library", "GET", { authorization: "" });
    expect(guardRequest(missing, gate)?.status).toBe(401);
    const wrong = guardedRequest("/api/library", "GET", { authorization: "Bearer nope" });
    expect(guardRequest(wrong, gate)?.status).toBe(401);
  });

  test("rejects cross-origin writes, foreign hosts, and preflight", () => {
    const crossOrigin = guardedRequest("/api/translate", "POST", {
      origin: "https://evil.example",
    });
    expect(guardRequest(crossOrigin, gate)?.status).toBe(403);

    const foreignHost = guardedRequest("/api/library", "GET", { host: "evil.example" });
    expect(guardRequest(foreignHost, gate)?.status).toBe(403);

    const preflight = guardedRequest("/api/library", "OPTIONS", { origin: gate.origin });
    expect(guardRequest(preflight, gate)?.status).toBe(403);
  });

  test("allows GET downloads without an Origin, but not writes", () => {
    expect(guardRequest(guardedRequest("/api/documents/abc/file"), gate)).toBeNull();
    const write = guardedRequest("/api/reader", "PATCH");
    expect(guardRequest(write, gate)?.status).toBe(403);
  });
});

describe("body and content checks", () => {
  test("rejects compressed bodies and non-JSON writes", () => {
    expect(() =>
      assertContentEncoding(request("/api/translate", { method: "POST" }, { "content-encoding": "gzip" })),
    ).toThrow(HttpError);
    expect(assertJsonContentType(request("/api/translate", { method: "POST" }, { "content-type": "application/json; charset=utf-8" }))).toBeUndefined();
    expect(() => assertJsonContentType(request("/api/translate", { method: "POST" }))).toThrow(HttpError);
  });

  test("caps bodies while reading, with and without Content-Length", async () => {
    const small = request("/api/translate", { method: "POST", body: "12345" });
    expect(new TextDecoder().decode(await readBody(small, 5))).toBe("12345");

    const tooLarge = request("/api/translate", { method: "POST", body: "123456" });
    await expect(readBody(tooLarge, 5)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  test("preserves exact bytes across a multi-chunk binary stream", async () => {
    const chunks = [
      new Uint8Array([0, 255, 1, 2]),
      new Uint8Array([3, 4, 128, 7]),
      new Uint8Array([9, 10, 200, 13]),
    ];
    const body = await readBody(streamRequest(chunks).request, 12);
    expect(Array.from(body)).toEqual([0, 255, 1, 2, 3, 4, 128, 7, 9, 10, 200, 13]);
  });

  test("rejects an uncounted or falsely counted stream past the actual-byte cap", async () => {
    const uncounted = streamRequest([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    await expect(readBody(uncounted.request, 5)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(uncounted.cancelled()).toBe(true);

    const falseCount = streamRequest(
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      { "content-length": "2" },
    );
    await expect(readBody(falseCount.request, 5)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(falseCount.cancelled()).toBe(true);
  });

  test("parses JSON against a schema and maps invalid input to 400", () => {
    const schema = z.strictObject({ page: z.number().int().min(1) });
    expect(parseJson(new TextEncoder().encode('{"page":2}'), schema)).toEqual({ page: 2 });
    expect(() => parseJson(new TextEncoder().encode('{"page":0}'), schema)).toThrow(HttpError);
    expect(() => parseJson(new TextEncoder().encode("{"), schema)).toThrow(HttpError);
  });
});

describe("classifyError", () => {
  test("maps domain and storage errors", () => {
    expect(classifyError(new PageOutOfRangeError(5, 2))).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
    expect(classifyError(new DocumentNotFoundError("a".repeat(64)))).toMatchObject({
      status: 404,
      code: "DOCUMENT_NOT_FOUND",
    });
    expect(classifyError(new HttpError(413, "PAYLOAD_TOO_LARGE", "too big"))).toEqual({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "too big",
    });
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(classifyError(busy)).toMatchObject({ status: 503, code: "STORAGE_BUSY" });
    const full = Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
    expect(classifyError(full)).toMatchObject({ status: 507, code: "STORAGE_FULL" });
  });
});
