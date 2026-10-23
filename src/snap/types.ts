/**
 * Types for SubQ's Snap decision model API (the "Decisions API").
 *
 * Snap never generates prose. You send it a `state` (text or structured
 * JSON describing a situation), optional `images`, plus a map of typed
 * `questions`, and it returns typed `answers` with probabilities.
 *
 * Endpoint: `POST https://api.subq.ai/v1/systemone`
 * Models:   `GET  https://api.subq.ai/v1/models`
 */

/** Any JSON-serialisable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The situation Snap should decide about: free text or structured JSON. */
export type SnapState = string | { [key: string]: unknown } | unknown[];

/**
 * An entry: the shapes `instructions` and `criteria` accept — plain text,
 * structured JSON (object or array), or null.
 */
export type SnapEntry =
  | string
  | { [key: string]: unknown }
  | unknown[]
  | null;

/** Map of option label -> description of that option (an entry). */
export type ChoiceCriteria = Record<string, SnapEntry>;

/** Ordered level descriptions for a Score question, lowest to highest. */
export type ScoreCriteria = SnapEntry[];

/**
 * Optional criteria for a Noul question: entries keyed by `"true"` /
 * `"false"`. May be omitted entirely.
 */
export type NoulCriteria = Record<string, SnapEntry>;

export interface ChoiceQuestion {
  type: "choice";
  instructions: SnapEntry;
  criteria: ChoiceCriteria;
}

export interface ScoreQuestion {
  type: "score";
  instructions: SnapEntry;
  criteria: ScoreCriteria;
}

export interface NoulQuestion {
  type: "noul";
  instructions: SnapEntry;
  criteria?: NoulCriteria;
}

export type SnapQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/**
 * One image sent alongside the state. Every question in the request sees
 * every image. PNG, JPEG, or WebP; at most 4 images per request, 4 MiB
 * decoded per image and 8 MiB decoded in total.
 */
export interface SnapImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** The file bytes as one line of base64, without a `data:` prefix. */
  base64: string;
}

/** Body sent to `POST /v1/systemone`. */
export interface SnapDecideRequest {
  /** Model id; defaults to the client's configured model (`subq-snap-1.1`). */
  model?: string;
  state: SnapState;
  /** 1-128 questions; names up to 100 characters. */
  questions: Record<string, SnapQuestion>;
  /** Up to 4 images, evaluated alongside the state. */
  images?: SnapImage[];
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  [key: string]: unknown;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted score; can fall between levels (e.g. 1.86). */
  score: number;
  /** Map of level index (as a string) to its description. */
  legend?: Record<string, string>;
  confidence?: number;
  probabilities?: Record<string, number> | number[];
  [key: string]: unknown;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability (0..1) that the proposition is true. */
  noul: number;
  [key: string]: unknown;
}

export type SnapAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Response returned by `POST /v1/systemone`. Extra fields are tolerated. */
export interface SnapDecideResponse {
  answers: Record<string, SnapAnswer>;
  /** Model id that produced the answers. */
  model?: string;
  usage?: {
    input_tokens?: number;
    /** Always 0: output tokens are free. */
    output_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SnapModelInfo {
  id: string;
  name?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
}

/** Response returned by `GET /v1/models` (OpenAI-compatible list shape). */
export interface SnapListModelsResponse {
  object?: string;
  data: SnapModelInfo[];
  [key: string]: unknown;
}
