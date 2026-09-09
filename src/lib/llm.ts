import { fal } from "@fal-ai/client";
import { FalProvider } from "./providers/fal";

export const LLM_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-4.1",
  "openai/gpt-oss-120b",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "meta-llama/llama-4-maverick",
  "deepseek/deepseek-v4-pro-0813",
] as const;

export const DEFAULT_SYSTEM_PROMPT =
  "You are a prompt-engineering assistant for an image generation tool. " +
  "Rewrite the user's prompt to be more vivid, specific, and visually rich " +
  "while preserving its core intent. Return only the rewritten prompt — " +
  "no preamble, no quotes, no explanation.";

const LS_MODEL_KEY = "aislap:llm-model";
const LS_INSTRUCTION_KEY = "aislap:llm-instruction";

export function loadLastLlmModel(): string {
  try {
    const v = localStorage.getItem(LS_MODEL_KEY);
    if (v && (LLM_MODELS as readonly string[]).includes(v)) return v;
  } catch {
    /* ignore */
  }
  return LLM_MODELS[0];
}

export function saveLastLlmModel(model: string): void {
  try {
    localStorage.setItem(LS_MODEL_KEY, model);
  } catch {
    /* ignore */
  }
}

export function loadLastLlmInstruction(): string {
  try {
    const v = localStorage.getItem(LS_INSTRUCTION_KEY);
    if (v != null) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_SYSTEM_PROMPT;
}

export function saveLastLlmInstruction(s: string): void {
  try {
    localStorage.setItem(LS_INSTRUCTION_KEY, s);
  } catch {
    /* ignore */
  }
}

export async function runLlmRewrite(args: {
  model: string;
  prompt: string;
  systemPrompt?: string;
  signal: AbortSignal;
}): Promise<string> {
  await new FalProvider().prepare();
  const res = await fal.subscribe("openrouter/router", {
    input: {
      model: args.model,
      prompt: args.prompt,
      system_prompt: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    },
    abortSignal: args.signal,
  });
  const data = (res.data ?? {}) as { output?: string };
  return (data.output ?? "").trim();
}

// ---------- Brief analysis (CONTEXT page) ----------

const BRIEF_MARKER = "===BRIEF===";
const SCRIPT_MARKER = "===SCRIPT===";

const BRIEF_ANALYSIS_SYSTEM_PROMPT =
  "You are a creative-brief analyst for a video/image production pipeline. " +
  "You will be given the raw extracted text of a pitch deck or brief " +
  "(slide-by-slide or page-by-page, possibly messy). Derive from it: " +
  "(1) a short prose summary of the brief — audience, goal, tone, key " +
  "requirements; (2) a shot-by-shot script broken into sequences and shots, " +
  "as markdown using a top-level '# ' heading per sequence and a '## ' " +
  "heading per shot underneath it, with one or two sentences of description " +
  `under each shot heading. Return your answer in exactly this format, with ` +
  `nothing before or after it:\n\n${BRIEF_MARKER}\n<the brief summary>\n` +
  `${SCRIPT_MARKER}\n<the markdown script>`;

export type BriefAnalysis = { brief: string; script: string };

/** Split a model's raw reply on the `===BRIEF===`/`===SCRIPT===` markers.
 *  Exported for testing and so a caller can inspect what actually came back
 *  even when the model didn't follow the format — falls back to treating the
 *  whole reply as the script with an empty brief, rather than discarding a
 *  real (just unlabeled) result. */
export function parseBriefAnalysis(raw: string): BriefAnalysis {
  const briefIdx = raw.indexOf(BRIEF_MARKER);
  const scriptIdx = raw.indexOf(SCRIPT_MARKER);
  if (briefIdx === -1 || scriptIdx === -1 || scriptIdx < briefIdx) {
    return { brief: "", script: raw.trim() };
  }
  return {
    brief: raw.slice(briefIdx + BRIEF_MARKER.length, scriptIdx).trim(),
    script: raw.slice(scriptIdx + SCRIPT_MARKER.length).trim(),
  };
}

/** Derive a brief summary + script.md-shaped breakdown from a brief's
 *  extracted text (see `commands::brief::brief_extract`). Never applies
 *  anything itself — the caller shows a confirm step before touching the
 *  live script, same as CREATE DIRS's own preview-then-confirm. */
export async function runBriefAnalysis(args: {
  model: string;
  extractedText: string;
  signal: AbortSignal;
}): Promise<BriefAnalysis> {
  await new FalProvider().prepare();
  const res = await fal.subscribe("openrouter/router", {
    input: {
      model: args.model,
      prompt: args.extractedText,
      system_prompt: BRIEF_ANALYSIS_SYSTEM_PROMPT,
    },
    abortSignal: args.signal,
  });
  const data = (res.data ?? {}) as { output?: string };
  return parseBriefAnalysis((data.output ?? "").trim());
}
