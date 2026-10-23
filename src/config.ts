/**
 * Environment configuration for the subq-snap-mcp server.
 *
 * - `SUBQ_API_KEY`    — Bearer <redacted> for the SubQ API. Optional at startup:
 *   the server must be able to start (and list its tools) without a key;
 *   tools return a clear error naming this variable when it is missing.
 * - `SUBQ_BASE_URL`   — API base URL (default `https://api.subq.ai`).
 * - `SUBQ_SNAP_MODEL` — Snap model id to request (default `subq-snap-1.1`).
 */

export interface SubqConfig {
  /** API key, or `undefined` when `SUBQ_API_KEY` is not set. */
  apiKey?: string;
  /** Base URL of the SubQ API, without a trailing slash. */
  baseUrl: string;
  /** Snap model identifier sent with each decision request. */
  model: string;
}

export const DEFAULT_BASE_URL = "https://api.subq.ai";
export const DEFAULT_MODEL = "subq-snap-1.1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SubqConfig {
  const apiKey = env.SUBQ_API_KEY?.trim();
  const baseUrlRaw = env.SUBQ_BASE_URL?.trim();
  const model = env.SUBQ_SNAP_MODEL?.trim();

  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl: (baseUrlRaw ? baseUrlRaw : DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: model ? model : DEFAULT_MODEL,
  };
}
