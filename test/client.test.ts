import { describe, expect, it, vi } from "vitest";

import { SnapClient, SnapError, type FetchLike } from "../src/snap/client.js";
import { loadConfig } from "../src/config.js";

interface CapturedCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a fake fetch that records its calls and delegates to a responder. */
function fakeFetch(responder: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: CapturedCall = {
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  });
  return { impl: impl as unknown as FetchLike, calls };
}

const sampleAnswers = {
  model: "subq-snap-1.1",
  answers: {
    escalate: { type: "noul", noul: 0.92 },
    queue: {
      type: "choice",
      choice: "nurse_line",
      probabilities: { nurse_line: 1, primary_care: 0, pharmacy: 0, front_desk: 0 },
      confidence: 1,
    },
    acuity: {
      type: "score",
      score: 1.86,
      legend: { "0": "Within a week", "1": "Within a day", "2": "Within an hour" },
      probabilities: { "0": 0, "1": 0.13, "2": 0.87 },
      confidence: 0.79,
    },
  },
  usage: { input_tokens: 477, output_tokens: 0 },
};

describe("SnapClient.decide", () => {
  it("posts to /v1/systemone with auth headers and the exact body shape for mixed question types", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ apiKey: "test-key-123", fetchImpl: impl });

    const result = await client.decide({
      state: "Patient with asthma reports a sore throat and fever since yesterday.",
      questions: {
        escalate: {
          type: "noul",
          instructions: "Should a nurse see this chat before the patient books anything?",
          criteria: {
            true: "Breathing trouble, chest pain, or a flare of a known condition",
            false: "Stable symptoms the patient can book for themselves",
          },
        },
        queue: {
          type: "choice",
          instructions: "Which team should own this chat?",
          criteria: {
            nurse_line: "Needs a nurse to assess symptoms today",
            primary_care: "Book with the patient's own doctor",
            front_desk: null,
          },
        },
        acuity: {
          type: "score",
          instructions: "How soon should someone respond?",
          criteria: ["Within a week", "Within a day", "Within an hour"],
        },
      },
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.subq.ai/v1/systemone");
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe("Bearer test-key-123");
    expect(call?.headers["Content-Type"]).toBe("application/json");
    expect(call?.body).toEqual({
      model: "subq-snap-1.1",
      state: "Patient with asthma reports a sore throat and fever since yesterday.",
      questions: {
        escalate: {
          type: "noul",
          instructions: "Should a nurse see this chat before the patient books anything?",
          criteria: {
            true: "Breathing trouble, chest pain, or a flare of a known condition",
            false: "Stable symptoms the patient can book for themselves",
          },
        },
        queue: {
          type: "choice",
          instructions: "Which team should own this chat?",
          criteria: {
            nurse_line: "Needs a nurse to assess symptoms today",
            primary_care: "Book with the patient's own doctor",
            front_desk: null,
          },
        },
        acuity: {
          type: "score",
          instructions: "How soon should someone respond?",
          criteria: ["Within a week", "Within a day", "Within an hour"],
        },
      },
    });

    expect(result.answers.escalate).toMatchObject({ type: "noul", noul: 0.92 });
    expect(result.answers.queue).toMatchObject({ type: "choice", choice: "nurse_line" });
    expect(result.answers.acuity).toMatchObject({ type: "score", score: 1.86 });
    expect(result.answers.acuity?.legend).toEqual({
      "0": "Within a week",
      "1": "Within a day",
      "2": "Within an hour",
    });
    expect(result.usage).toEqual({ input_tokens: 477, output_tokens: 0 });
  });

  it("omits noul criteria when not provided and honours a per-request model override", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    await client.decide({
      model: "subq-snap-1.1",
      state: { ticket_id: 42, channel: "email" },
      questions: {
        spam: { type: "noul", instructions: "Is this spam?" },
      },
    });

    expect(calls[0]?.body).toEqual({
      model: "subq-snap-1.1",
      state: { ticket_id: 42, channel: "email" },
      questions: { spam: { type: "noul", instructions: "Is this spam?" } },
    });
  });

  it("sends images in the body when provided", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    await client.decide({
      state: "The number row stopped working.",
      questions: {
        shows_keyboard: { type: "noul", instructions: "Does the photo show a keyboard?" },
      },
      images: [{ mediaType: "image/jpeg", base64: "aGVsbG8=" }],
    });

    expect(calls[0]?.body).toMatchObject({
      images: [{ mediaType: "image/jpeg", base64: "aGVsbG8=" }],
    });
  });

  it("fails with a SUBQ_API_KEY error and never calls fetch when the key is missing", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ fetchImpl: impl });

    await expect(
      client.decide({
        state: "anything",
        questions: { q: { type: "noul", instructions: "Is it true?" } },
      }),
    ).rejects.toThrow(/SUBQ_API_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe("SnapClient image validation", () => {
  const question = {
    q: { type: "noul", instructions: "Is it true?" } as const,
  };

  it("rejects more than 4 images before calling fetch", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });
    const image = { mediaType: "image/png" as const, base64: "aGVsbG8=" };

    await expect(
      client.decide({ state: "s", questions: question, images: [image, image, image, image, image] }),
    ).rejects.toThrow(/at most 4/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a data: URL prefix before calling fetch", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    await expect(
      client.decide({
        state: "s",
        questions: question,
        images: [{ mediaType: "image/png", base64: "data:image/png;base64,aGVsbG8=" }],
      }),
    ).rejects.toThrow(/base64/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an image over 4 MiB decoded before calling fetch", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, sampleAnswers));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });
    const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");

    await expect(
      client.decide({
        state: "s",
        questions: question,
        images: [{ mediaType: "image/png", base64: big }],
      }),
    ).rejects.toThrow(/4 MiB/);
    expect(calls).toHaveLength(0);
  });
});

describe("SnapClient.listModels", () => {
  it("GETs /v1/models and parses the OpenAI-compatible data array", async () => {
    const payload = {
      object: "list",
      data: [
        { id: "subq-preview", name: "SubQ Preview", object: "model", created: 0, owned_by: "subquadratic" },
        { id: "subq-snap-1.1", name: "SubQ Snap 1.1", object: "model", created: 0, owned_by: "subquadratic" },
      ],
    };
    const { impl, calls } = fakeFetch(() => jsonResponse(200, payload));
    const client = new SnapClient({
      apiKey: "k",
      baseUrl: "https://example.test/api/",
      fetchImpl: impl,
    });

    const result = await client.listModels();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.test/api/v1/models");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.Authorization).toBe("Bearer k");
    expect(result.data).toHaveLength(2);
    expect(result.data[1]).toMatchObject({ id: "subq-snap-1.1" });
  });
});

describe("SnapClient error mapping", () => {
  it("maps 401 to an authentication error that never contains the API key", async () => {
    const secret = "sk-super-secret-key";
    const { impl } = fakeFetch(() =>
      jsonResponse(401, { detail: { error_type: "authentication_error", message: "invalid api key" } }),
    );
    const client = new SnapClient({ apiKey: secret, fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBe(401);
    expect((err as SnapError).message).toContain("401");
    expect((err as SnapError).message).toContain("SUBQ_API_KEY");
    expect((err as SnapError).message).not.toContain(secret);
  });

  it("maps 402 to an insufficient-credits error", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse(402, { detail: { error_type: "insufficient_credits", message: "balance too low" } }),
    );
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBe(402);
    expect((err as SnapError).message).toMatch(/insufficient credits/i);
  });

  it("maps 403 to a model-access error", async () => {
    const { impl } = fakeFetch(() => jsonResponse(403, { detail: "forbidden" }));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBe(403);
    expect((err as SnapError).message).toMatch(/cannot use the requested model/i);
  });

  it("surfaces the API's detail message on 422", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse(422, {
        detail: { error_type: "validation_error", message: "images/0: image over 4 MiB" },
      }),
    );
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBe(422);
    expect((err as SnapError).message).toContain("validation_error");
    expect((err as SnapError).message).toContain("images/0: image over 4 MiB");
  });

  it("maps 429 to a rate-limit error", async () => {
    const { impl } = fakeFetch(() => jsonResponse(429, { detail: { message: "slow down" } }));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBe(429);
    expect((err as SnapError).message).toMatch(/rate limit/i);
  });

  it("maps 503 to a temporarily-unavailable error", async () => {
    const { impl } = fakeFetch(() => jsonResponse(503, {}));
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBe(503);
    expect((err as SnapError).message).toMatch(/temporarily unavailable/i);
  });

  it("maps a network failure to a clear error without a status", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as FetchLike;
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).status).toBeUndefined();
    expect((err as SnapError).message).toMatch(/network error/i);
  });

  it("maps a timeout (AbortError) to a timeout error", async () => {
    const impl = vi.fn(async () => {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }) as unknown as FetchLike;
    const client = new SnapClient({ apiKey: "k", fetchImpl: impl, timeoutMs: 5 });

    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapError);
    expect((err as SnapError).message).toMatch(/timed out/i);
  });
});

describe("loadConfig", () => {
  it("applies documented defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.baseUrl).toBe("https://api.subq.ai");
    expect(config.model).toBe("subq-snap-1.1");
    expect(config.apiKey).toBeUndefined();
  });

  it("reads overrides and trims a trailing slash from the base URL", () => {
    const config = loadConfig({
      SUBQ_API_KEY: "  abc  ",
      SUBQ_BASE_URL: "https://staging.example.test/",
      SUBQ_SNAP_MODEL: "subq-snap-1.1",
    });
    expect(config.apiKey).toBe("abc");
    expect(config.baseUrl).toBe("https://staging.example.test");
    expect(config.model).toBe("subq-snap-1.1");
  });
});
