# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-23

- Updated `@modelcontextprotocol/sdk` to 1.32.2 (patch release within the declared range). No tool, schema, or behaviour changes.

## [0.1.0] - 2026-10-23

### Added

- Initial release of `subq-snap-mcp`, a Model Context Protocol (stdio)
  server wrapping SubQ's Snap decision model (`subq-snap-1.1`, Decisions
  API at `POST /v1/systemone`).
- Tools: `snap_decide` (up to 128 typed questions in one call),
  `snap_choice`, `snap_score` (2–10 levels, probability-weighted score
  with legend), `snap_noul`, and `snap_list_models` (`GET /v1/models`,
  OpenAI-compatible list shape).
- Image inputs on every decision tool: up to 4 PNG/JPEG/WebP images as
  `{mediaType, base64}`, with the documented limits (4 MiB each, 8 MiB
  total) checked locally before sending.
- Structured `instructions` and `criteria` (strings, JSON objects/arrays,
  or null), per the Decisions API documentation.
- Typed TypeScript Snap client with clear, credential-free error mapping,
  including the API's `{detail: {error_type, message}}` error bodies and
  the 402 insufficient-credits and 403 model-access statuses.
- Configuration via `SUBQ_API_KEY`, `SUBQ_BASE_URL`, and `SUBQ_SNAP_MODEL`
  environment variables. The server starts without a key; tools return a
  clear error naming the missing variable.
- Unit tests (vitest) using an injected fake fetch — no live network calls.
- GitHub Actions: CI on Node 20/22 plus a Bun build smoke job, and a
  publish workflow that releases to npm with provenance when a GitHub
  Release is published.
