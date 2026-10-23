import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { SubqConfig } from "./config.js";
import { SnapClient, SnapError, isValidBase64 } from "./snap/client.js";
import type {
  ChoiceCriteria,
  NoulCriteria,
  ScoreCriteria,
  SnapEntry,
  SnapQuestion,
} from "./snap/types.js";

/** Name under which the single-question tools return their answer. */
const SINGLE_QUESTION_NAME = "answer";

const stateSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

/** A Snap entry: text, structured JSON (object or array), or null. */
const entrySchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.null(),
]);

/** Instructions: an entry; strings must not be empty. */
const instructionsSchema = z.union([
  z.string().min(1, "instructions must not be empty"),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.null(),
]);

function isEntryValue(value: unknown): boolean {
  return (
    value === null || typeof value === "string" || typeof value === "object"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Images for a request, evaluated alongside the state. */
const imagesSchema = z
  .array(
    z.object({
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      base64: z
        .string()
        .min(1)
        .refine(isValidBase64, {
          message:
            "base64 must be one line of standard base64 with no data: prefix",
        }),
    }),
  )
  .max(4, "at most 4 images per request")
  .describe(
    "Up to 4 images for this request. PNG, JPEG, or WebP, base64-encoded " +
      "with no data: prefix; at most 4 MiB decoded each, 8 MiB in total. " +
      "Every question in the request sees every image.",
  );

const modelSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Optional Snap model id override (default: subq-snap-1.1).");

/** One typed question for `snap_decide`, validated per question type. */
const questionSchema = z
  .object({
    type: z.enum(["choice", "score", "noul"]),
    instructions: z.unknown(),
    criteria: z.unknown().optional(),
  })
  .superRefine((question, ctx) => {
    const { type, criteria, instructions } = question;
    if (
      !isEntryValue(instructions) ||
      (typeof instructions === "string" && instructions.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "instructions must be a non-empty string, a structured object or array, or null",
        path: ["instructions"],
      });
      return;
    }
    if (type === "choice") {
      if (!isPlainObject(criteria)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "choice questions require criteria: an object mapping each option label to its description",
          path: ["criteria"],
        });
        return;
      }
      const count = Object.keys(criteria).length;
      if (count < 2 || count > 255) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `choice questions require 2-255 options, got ${count}`,
          path: ["criteria"],
        });
      }
      for (const [label, value] of Object.entries(criteria)) {
        if (!isEntryValue(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `choice option "${label}" must map to a description: a string, a structured object or array, or null`,
            path: ["criteria", label],
          });
        }
      }
    } else if (type === "score") {
      if (
        !Array.isArray(criteria) ||
        criteria.length < 2 ||
        criteria.length > 10 ||
        !criteria.every((level) => isEntryValue(level))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "score questions require criteria: an array of 2-10 ordered level descriptions (strings or structured objects/arrays)",
          path: ["criteria"],
        });
      }
    } else if (type === "noul") {
      if (criteria !== undefined) {
        if (!isPlainObject(criteria)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "noul criteria must be an object with true/false descriptions",
            path: ["criteria"],
          });
        } else {
          for (const [label, value] of Object.entries(criteria)) {
            if (!isEntryValue(value)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `noul criteria "${label}" must map to a description: a string, a structured object or array, or null`,
                path: ["criteria", label],
              });
            }
          }
        }
      }
    }
  });

function toSnapQuestion(
  question: z.infer<typeof questionSchema>,
): SnapQuestion {
  switch (question.type) {
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions as SnapEntry,
        criteria: question.criteria as ChoiceCriteria,
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions as SnapEntry,
        criteria: question.criteria as ScoreCriteria,
      };
    case "noul":
      return question.criteria === undefined
        ? { type: "noul", instructions: question.instructions as SnapEntry }
        : {
            type: "noul",
            instructions: question.instructions as SnapEntry,
            criteria: question.criteria as NoulCriteria,
          };
  }
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof SnapError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function createServer(opts?: { config?: SubqConfig }): McpServer {
  const client =
    opts?.config !== undefined
      ? new SnapClient({
          ...(opts.config.apiKey !== undefined
            ? { apiKey: opts.config.apiKey }
            : {}),
          baseUrl: opts.config.baseUrl,
          model: opts.config.model,
        })
      : new SnapClient();

  const server = new McpServer({
    name: "subq-snap-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "snap_decide",
    {
      title: "Snap: decide (typed questions over a state)",
      description:
        "Ask SubQ's Snap decision model one or more typed questions " +
        "(choice, score and/or noul) about a state in a single call. " +
        "Returns typed answers with probabilities. The state may be text " +
        "or structured JSON, and up to 4 images may accompany it; every " +
        "question sees the state and every image.",
      inputSchema: {
        state: stateSchema.describe(
          "The situation to decide about: text, a JSON object, or a JSON array.",
        ),
        questions: z
          .record(z.string(), questionSchema)
          .superRefine((questions, ctx) => {
            const names = Object.keys(questions);
            if (names.length < 1 || names.length > 128) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `a request needs 1-128 questions, got ${names.length}`,
              });
            }
            for (const name of names) {
              if (name.length > 100) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `question name "${name.slice(0, 24)}..." is over 100 characters`,
                  path: [name],
                });
              }
            }
          })
          .describe(
            "Map of question name (up to 100 characters) to typed " +
              "question; 1-128 questions. Each question has a type " +
              "(choice | score | noul), instructions, and criteria: " +
              "choice = object of option label -> description (string, " +
              "structured object/array, or null; 2-255 options); " +
              "score = array of 2-10 ordered level descriptions; " +
              "noul = optional object of true/false descriptions. " +
              "Instructions may be text or structured JSON.",
          ),
        images: imagesSchema.optional(),
        model: modelSchema,
      },
    },
    async ({ state, questions, images, model }) => {
      try {
        const typed: Record<string, SnapQuestion> = {};
        for (const [name, question] of Object.entries(questions)) {
          typed[name] = toSnapQuestion(question);
        }
        const result = await client.decide({
          state,
          questions: typed,
          ...(images ? { images } : {}),
          ...(model ? { model } : {}),
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "snap_choice",
    {
      title: "Snap: choice question",
      description:
        "Ask SubQ's Snap decision model a single Choice question: pick " +
        "one of 2-255 labelled options for a state. Returns the chosen " +
        "option, a confidence value, and a probability for every option, " +
        'under the question name "answer".',
      inputSchema: {
        state: stateSchema.describe(
          "The situation to decide about: text, a JSON object, or a JSON array.",
        ),
        instructions: instructionsSchema.describe(
          "What Snap should decide: plain-language text, or structured JSON.",
        ),
        options: z
          .record(z.string(), entrySchema)
          .refine(
            (options) => {
              const count = Object.keys(options).length;
              return count >= 2 && count <= 255;
            },
            { message: "choice questions require 2-255 options" },
          )
          .describe(
            "Object mapping each option label to a description (string, structured object/array, or null; 2-255 options).",
          ),
        images: imagesSchema.optional(),
        model: modelSchema,
      },
    },
    async ({ state, instructions, options, images, model }) => {
      try {
        const result = await client.decide({
          state,
          questions: {
            [SINGLE_QUESTION_NAME]: {
              type: "choice",
              instructions,
              criteria: options,
            },
          },
          ...(images ? { images } : {}),
          ...(model ? { model } : {}),
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "snap_score",
    {
      title: "Snap: score question",
      description:
        "Ask SubQ's Snap decision model a single Score question: rate a " +
        "state on an ordered scale of 2-10 levels you define. Returns a " +
        "probability-weighted score (it can fall between levels), the " +
        "level legend, per-level probabilities, and a confidence value, " +
        'under the question name "answer".',
      inputSchema: {
        state: stateSchema.describe(
          "The situation to rate: text, a JSON object, or a JSON array.",
        ),
        instructions: instructionsSchema.describe(
          "What Snap should rate: plain-language text, or structured JSON.",
        ),
        levels: z
          .array(entrySchema)
          .min(2, "score questions require at least 2 levels")
          .max(10, "score questions allow at most 10 levels")
          .describe(
            "Ordered level descriptions, lowest to highest (2-10). Each level may be a string or a structured entry.",
          ),
        images: imagesSchema.optional(),
        model: modelSchema,
      },
    },
    async ({ state, instructions, levels, images, model }) => {
      try {
        const result = await client.decide({
          state,
          questions: {
            [SINGLE_QUESTION_NAME]: {
              type: "score",
              instructions,
              criteria: levels,
            },
          },
          ...(images ? { images } : {}),
          ...(model ? { model } : {}),
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "snap_noul",
    {
      title: "Snap: noul question (yes/no probability)",
      description:
        "Ask SubQ's Snap decision model a single Noul question: is a " +
        "proposition about a state true? Returns a calibrated probability " +
        '(0..1) under the question name "answer".',
      inputSchema: {
        state: stateSchema.describe(
          "The situation to assess: text, a JSON object, or a JSON array.",
        ),
        instructions: instructionsSchema.describe(
          "The proposition Snap should assess: plain-language text, or structured JSON.",
        ),
        criteria: z
          .record(z.string(), entrySchema)
          .optional()
          .describe(
            'Optional descriptions keyed by "true" / "false" explaining what each outcome means. Values may be strings, structured objects/arrays, or null.',
          ),
        images: imagesSchema.optional(),
        model: modelSchema,
      },
    },
    async ({ state, instructions, criteria, images, model }) => {
      try {
        const result = await client.decide({
          state,
          questions: {
            [SINGLE_QUESTION_NAME]: {
              type: "noul",
              instructions,
              ...(criteria !== undefined ? { criteria } : {}),
            },
          },
          ...(images ? { images } : {}),
          ...(model ? { model } : {}),
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "snap_list_models",
    {
      title: "Snap: list available models",
      description:
        "List the model IDs available to the configured SubQ API key " +
        "(GET /v1/models, OpenAI-compatible shape). Use a returned id " +
        "with the endpoint that supports that model; the Decisions tools " +
        "in this server need a decision model such as subq-snap-1.1.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.listModels();
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
