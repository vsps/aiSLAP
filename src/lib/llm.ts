import { fal } from "@fal-ai/client";
import { FalProvider } from "./providers/fal";

export const LLM_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4.1",
  "openai/gpt-oss-120b",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "meta-llama/llama-4-maverick",
  "deepseek/deepseek-v3",
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
