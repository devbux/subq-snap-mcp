import { loadConfig } from "../config.js";
import type {
  SnapDecideRequest,
  SnapDecideResponse,
  SnapImage,
  SnapListModelsResponse,
  SnapQuestion,
} from "./types.js";

/** Error thrown for any failed SubQ API interaction. */
export class SnapError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SnapError";
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/** Minimal fetch signature, so tests can inject a fake. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SnapClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.subq.ai";
const DEFAULT_MODEL = "subq-snap-1.1";
const DEFAULT_TIMEOUT_MS = 30_000;

/** The Decisions API's documented image limits. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB decoded, per image
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB decoded, in total

/**
 * Stack-safe base64 shape check: standard alphabet, `=` padding only at
 * the end, total length a multiple of 4, no whitespace. A single regex
 * over a multi-megabyte string can overflow the regex engine's stack,
 * so the character set is tested in chunks.
 */
export function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (/\s/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const body = padding > 0 ? value.slice(0, -padding) : value;
  if (body.includes("=")) return false;
  for (let i = 0; i < body.length; i += 8192) {
    if (!/^[A-Za-z0-9+/]+$/.test(body.slice(i, i + 8192))) return false;
  }
  return true;
}

export class SnapClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: SnapClientOptions = {}) {
    if (
      options.apiKey === undefined &&
      options.baseUrl === undefined &&
      options.model === undefined &&
      options.fetchImpl === undefined &&
      options.timeoutMs === undefined
    ) {
      const config = loadConfig();
      options = { ...options, ...config };
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Ask Snap one or more typed questions about a state.
   * Calls `POST /v1/systemone`.
   */
  async decide(request: SnapDecideRequest): Promise<SnapDecideResponse> {
    const questions: Record<string, SnapQuestion> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type === "noul" && question.criteria === undefined) {
        // Omit empty noul criteria entirely, as the API expects.
        const { criteria: _omitted, ...rest } = question;
        questions[name] = rest as SnapQuestion;
      } else {
        questions[name] = question;
      }
    }

    const images = request.images;
    if (images !== undefined && images.length > 0) {
      validateImages(images);
    }

    const body = {
      model: request.model ?? this.model,
      state: request.state,
      questions,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    };

    const data = await this.requestJson<unknown>("/v1/systemone", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { answers?: unknown }).answers !== "object" ||
      (data as { answers?: unknown }).answers === null
    ) {
      throw new SnapError(
        "Unexpected response from the SubQ API: missing 'answers' object.",
      );
    }
    return data as SnapDecideResponse;
  }

  /** List the models available to this API key. Calls `GET /v1/models`. */
  async listModels(): Promise<SnapListModelsResponse> {
    const data = await this.requestJson<unknown>("/v1/models", {
      method: "GET",
    });

    if (
      typeof data !== "object" ||
      data === null ||
      !Array.isArray((data as { data?: unknown }).data)
    ) {
      throw new SnapError(
        "Unexpected response from the SubQ API: missing 'data' array.",
      );
    }
    return data as SnapListModelsResponse;
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new SnapError(
        "SUBQ_API_KEY is not set. Set the SUBQ_API_KEY environment " +
          "variable to your SubQ API key and restart the server.",
      );
    }
    return this.apiKey;
  }

  private async requestJson<T>(
    path: string,
    init: { method: string; body?: string },
  ): Promise<T> {
    const apiKey = this.requireApiKey();
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SnapError(
          `Request to the SubQ API timed out after ${this.timeoutMs} ms.`,
        );
      }
      throw new SnapError(
        `Network error while contacting the SubQ API: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      throw new SnapError(
        httpErrorMessage(response.status, parsed),
        response.status,
      );
    }
    return parsed as T;
  }
}

/**
 * The API rejects invalid images with 422. Fail fast with a clearer
 * message instead: at most 4 images, plain single-line base64 with no
 * `data:` prefix, at most 4 MiB decoded each and 8 MiB in total.
 */
function validateImages(images: SnapImage[]): void {
  if (images.length > MAX_IMAGES) {
    throw new SnapError(
      `Too many images: the Decisions API accepts at most ${MAX_IMAGES} per request.`,
    );
  }
  let total = 0;
  images.forEach((image, index) => {
    if (!isValidBase64(image.base64)) {
      throw new SnapError(
        `images/${index}: base64 must be one line of standard base64 with padding and no data: prefix.`,
      );
    }
    const bytes = Buffer.byteLength(image.base64, "base64");
    if (bytes > MAX_IMAGE_BYTES) {
      throw new SnapError(
        `images/${index}: image over 4 MiB (decoded size ${bytes} bytes).`,
      );
    }
    total += bytes;
  });
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    throw new SnapError(
      `Images total ${total} bytes decoded, over the 8 MiB limit.`,
    );
  }
}

/** Build a clear, credential-free message for an HTTP error response. */
function httpErrorMessage(status: number, body: unknown): string {
  // The API reports errors as { detail: { error_type, message } }.
  let detail = "";
  if (typeof body === "object" && body !== null) {
    const raw = (body as { detail?: unknown }).detail;
    if (typeof raw === "string") {
      detail = raw;
    } else if (typeof raw === "object" && raw !== null) {
      const type = (raw as { error_type?: unknown }).error_type;
      const message = (raw as { message?: unknown }).message;
      const parts = [
        typeof type === "string" ? type : "",
        typeof message === "string" ? message : "",
      ].filter((part) => part.length > 0);
      detail = parts.join(": ");
    }
  }

  let hint: string;
  switch (status) {
    case 400:
      hint =
        "the request was rejected (over the model's token limit, or the model rejected it)";
      break;
    case 401:
      hint =
        "authentication failed: check that SUBQ_API_KEY is set to a valid SubQ API key";
      break;
    case 402:
      hint = "insufficient credits on the SubQ account for this API key";
      break;
    case 403:
      hint = "this API key cannot use the requested model";
      break;
    case 422:
      hint = "the request was invalid";
      break;
    case 429:
      hint = "rate limit exceeded: slow down and retry later";
      break;
    case 503:
      hint = "the SubQ service is temporarily unavailable";
      break;
    default:
      hint =
        status >= 500
          ? "the SubQ API had a server error"
          : "the request failed";
  }

  return (
    `SubQ API error (HTTP ${status}): ${hint}` +
    (detail ? ` — ${detail}` : "")
  );
}
