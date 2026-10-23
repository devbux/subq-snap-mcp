# subq-snap-mcp

A standard [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that exposes **SubQ's Snap decision model** as typed tools —
publishable to npm and runnable anywhere with `npx` or `bunx`.

```bash
npx -y @devbux/subq-snap-mcp
```

## What is Snap?

Snap is SubQ's **decision model** (currently `subq-snap-1.1`, public
preview). It never generates prose. Instead, you give it:

- a **`state`** — a situation described as text or structured JSON,
- up to **4 images** to evaluate alongside the state, and
- a set of **typed questions** about that state,

and Snap returns **typed answers with probabilities**:

| Question type | You define | Snap returns |
| --- | --- | --- |
| `choice` | 2–255 labelled options (each with an optional description) | the chosen option, a confidence value, and a probability for every option |
| `score` | an ordered scale of 2–10 level descriptions | a probability-weighted score (it can fall between levels), the level legend, confidence, and per-level probabilities |
| `noul` | a proposition (optionally with true/false descriptions) | a probability (0..1) that the proposition is true |

Because the output is structured and probabilistic rather than free text,
Snap is well suited to routing, triage, moderation, risk scoring,
prioritisation, and any other "decide, don't chat" step inside an agent
workflow. One call can ask up to 128 questions, and every question sees
the same state and every image.

Scope: this server wraps SubQ's **Decisions API** and **Models API**. The
separate `subq-preview` chat model (Chat Completions / Responses APIs,
structured outputs, function calling) is not a decision model and is out
of scope here.

## Requirements

- Node.js **>= 18** (or Bun) to run the server.
- A SubQ API key (see [Getting an API key](#getting-an-api-key)).

## Install & run

The server speaks MCP over **stdio**, so you normally don't run it by hand —
your MCP client launches it. The commands below are how clients (or you, for a
quick smoke test) start it.

### npx (Node)

```bash
SUBQ_API_KEY=your-key npx -y @devbux/subq-snap-mcp
```

### bunx (Bun)

```bash
SUBQ_API_KEY=your-key bunx @devbux/subq-snap-mcp
```

### Global install (npm)

```bash
npm install -g @devbux/subq-snap-mcp
SUBQ_API_KEY=your-key subq-snap-mcp
```

### Global install (Bun)

```bash
bun add -g @devbux/subq-snap-mcp
SUBQ_API_KEY=your-key subq-snap-mcp
```

> The server starts even when `SUBQ_API_KEY` is not set, so clients can
> still list its tools; each tool call then returns a clear error naming the
> missing variable instead of crashing.

## Getting an API key

Create an API key in your SubQ account (see [docs.subq.ai](https://docs.subq.ai)),
then expose it to the server as the `SUBQ_API_KEY` environment variable.
Never commit your key to source control.

## MCP client configuration

### Generic (`mcpServers` JSON)

Most MCP clients (Claude Desktop, and many others) accept a configuration
like this — see also [`examples/mcp-config.json`](examples/mcp-config.json):

```json
{
  "mcpServers": {
    "subq": {
      "command": "npx",
      "args": ["-y", "@devbux/subq-snap-mcp"],
      "env": {
        "SUBQ_API_KEY": "YOUR_SUBQ_API_KEY"
      }
    }
  }
}
```

Using Bun instead:

```json
{
  "mcpServers": {
    "subq": {
      "command": "bunx",
      "args": ["@devbux/subq-snap-mcp"],
      "env": {
        "SUBQ_API_KEY": "YOUR_SUBQ_API_KEY"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add subq \
  -e SUBQ_API_KEY=YOUR_SUBQ_API_KEY \
  -- npx -y @devbux/subq-snap-mcp
```

### Cursor / VS Code

Cursor and VS Code use the same `mcpServers` JSON shape above (Cursor:
`.cursor/mcp.json` or Settings → MCP; VS Code: `.vscode/mcp.json` uses a
top-level `"servers"` key with the same per-server fields). Paste the generic
config and replace the placeholder key.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `SUBQ_API_KEY` | _(unset)_ | Bearer API key for the SubQ API. Required for tool calls; the server still starts without it. |
| `SUBQ_BASE_URL` | `https://api.subq.ai` | Base URL of the SubQ API. |
| `SUBQ_SNAP_MODEL` | `subq-snap-1.1` | Snap model id to request. Can be overridden per call with the tools' optional `model` argument. Use `snap_list_models` to see what your key can access. |

## Tools

All tools return the SubQ API response as JSON text content. Errors (missing
API key, HTTP 400/401/402/403/422/429/5xx, network failures, timeouts) are
returned as MCP tool errors (`isError`) with a clear message that includes
the HTTP status and the API's own error detail — never your API key.

| Tool | Inputs | Output |
| --- | --- | --- |
| `snap_decide` | `state` (string \| JSON object \| JSON array), `questions` (map of name → typed question, 1–128), optional `images`, `model` | All answers in one call: `{ model, answers, usage }` |
| `snap_choice` | `state`, `instructions`, `options` (object: label → description or `null`, 2–255), optional `images`, `model` | One Choice answer under the name `answer` |
| `snap_score` | `state`, `instructions`, `levels` (array of level descriptions, 2–10, ordered low → high), optional `images`, `model` | One Score answer under the name `answer` |
| `snap_noul` | `state`, `instructions`, optional `criteria` (`{ "true": ..., "false": ... }` descriptions), optional `images`, `model` | One Noul answer (probability 0..1) under the name `answer` |
| `snap_list_models` | _(none)_ | `{ object: "list", data: [{ id, name, object, created, owned_by }] }` |

### Question shapes for `snap_decide`

```jsonc
{
  "type": "choice",
  "instructions": "Which team should own this chat?",
  "criteria": { "nurse_line": "Needs a nurse today", "front_desk": null }
}
```

```jsonc
{
  "type": "score",
  "instructions": "How soon should someone respond?",
  "criteria": ["Within a week", "Within a day", "Within an hour"]
}
```

```jsonc
{
  "type": "noul",
  "instructions": "Should a nurse see this chat first?"
  // "criteria" is optional for noul and omitted when not provided
}
```

`instructions` and `criteria` accept structured JSON (objects/arrays) as
well as strings, so a criterion can carry the data it is judged against.

## Images

Any decision tool accepts an optional `images` array. Each image is an
object with a `mediaType` (`image/png`, `image/jpeg`, or `image/webp`) and
the file bytes as one line of `base64` (no `data:` prefix — URLs and
`data:` URLs are rejected by the API). Every question in the request sees
every image, alongside the state.

```json
{
  "state": "The number row stopped working.",
  "images": [{ "mediaType": "image/jpeg", "base64": "<base64 of the photo>" }],
  "questions": {
    "shows_keyboard": {
      "type": "noul",
      "instructions": "Does the photo show a keyboard?"
    }
  }
}
```

Limits from the SubQ docs:

- At most **4 images** per request; each at most **4 MiB** decoded, and
  **8 MiB** decoded in total. The request body can be up to 13 MiB.
- The image bytes must match the declared `mediaType`, or the API fails
  the request with `422`. This server checks the count, the base64 shape,
  and the decoded sizes before sending, so those mistakes come back as
  clear local errors.
- Each image uses roughly 64–256 image tokens (not the base64 text),
  counted toward the model's **384K-token** context window together with
  the request text.
- Video is not supported; sample up to 4 frames and send them as images.
- Note: SubQ stores decisions together with their images, under SubQ's
  data-retention policy.

## Worked example

An employee reports a broken keyboard and attaches a photo. In **one**
`snap_decide` call you can check the photo, classify the device, and grade
its wear:

**Request** (tool `snap_decide`):

```json
{
  "state": "The number row stopped working.",
  "images": [{ "mediaType": "image/jpeg", "base64": "<base64 of the photo>" }],
  "questions": {
    "shows_keyboard": {
      "type": "noul",
      "instructions": "Does the photo show a keyboard?",
      "criteria": {
        "true": "A keyboard is the main object",
        "false": "No keyboard is visible"
      }
    },
    "layout": {
      "type": "choice",
      "instructions": "Which keyboard layout is in the photo?",
      "criteria": {
        "full_size": "Desktop keyboard with a numeric keypad",
        "tenkeyless": "Desktop keyboard with no numeric keypad",
        "laptop": "Built into a laptop",
        "not_a_keyboard": null
      }
    },
    "wear": {
      "type": "score",
      "instructions": "How worn does the keyboard look?",
      "criteria": ["Looks new", "Everyday wear", "Replace it"]
    }
  }
}
```

**Response** (shape; exact values come from the live model):

```json
{
  "model": "subq-snap-1.1",
  "answers": {
    "shows_keyboard": { "type": "noul", "noul": 0.98 },
    "layout": {
      "type": "choice",
      "choice": "tenkeyless",
      "probabilities": { "full_size": 0.04, "tenkeyless": 0.9, "laptop": 0.05, "not_a_keyboard": 0.01 },
      "confidence": 0.9
    },
    "wear": {
      "type": "score",
      "score": 1.35,
      "legend": { "0": "Looks new", "1": "Everyday wear", "2": "Replace it" },
      "probabilities": { "0": 0.15, "1": 0.55, "2": 0.3 },
      "confidence": 0.72
    }
  },
  "usage": { "input_tokens": 210, "output_tokens": 0 }
}
```

Pricing note: you pay only for input tokens (`output_tokens` is always 0);
Snap is $0.04 per million input tokens at the time of writing.

## Development

```bash
git clone https://github.com/devbux/subq-snap-mcp.git
cd subq-snap-mcp

npm install
npm run dev        # run the server from source with tsx (stdio)
npm run typecheck  # tsc --noEmit
npm test           # vitest (fake fetch — no live network calls)
npm run build      # bundle to dist/index.js with tsup
npm start          # run the built server
```

Project layout:

```text
src/
  index.ts       stdio bootstrap
  server.ts      MCP server + the five snap_* tools (zod-validated)
  config.ts      environment parsing (SUBQ_*)
  snap/
    client.ts    typed SnapClient for POST /v1/systemone and GET /v1/models
    types.ts     request/response types for the SubQ API
test/
  client.test.ts SnapClient + config unit tests
```

## Publishing

Releases are published to npm by the **Publish to npm** GitHub Action
(`.github/workflows/publish.yml`):

1. Bump the version in `package.json`, update `CHANGELOG.md`, and push.
2. Create a **GitHub Release** for the new version tag (or run the workflow
   manually with `workflow_dispatch`).
3. The workflow runs typecheck, tests, and build, then publishes with
   `npm publish --provenance --access public`.

Notes:

- The workflow expects an `NPM_TOKEN` repository secret (an npm automation
  token for an account/organisation that owns the `@devbux` scope) **in
  this repository's settings**.
- Provenance is enabled (`id-token: write` permission + `--provenance`), so
  each published version is linked to its GitHub Actions build.
- This is a **scoped** package (`@devbux/subq-snap-mcp`); `publishConfig.access`
  is set to `public` in `package.json` so releases are publicly installable.
- `prepublishOnly` also runs typecheck, tests, and build for manual publishes.

## License

[MIT](LICENSE) © 2026 devbux
