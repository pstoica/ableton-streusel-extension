/**
 * LLM pattern generation — provider-agnostic, no SDK imports so it stays testable.
 *
 * The model is taught the Streusel mini-notation and asked to return ONE pattern
 * per line (no prose). We then keep only lines that actually parse, so malformed
 * output is dropped rather than written into a clip.
 */
import { parse } from "./parser.js";

export type Provider = "anthropic" | "openai";

export interface LlmConfig {
  provider: Provider;
  model: string;
  apiKey: string;
}

export interface KeyContext {
  rootNote: number;        // 0–11
  scaleIntervals: number[];
  bpm: number;
}

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
};

/** Suggested model IDs per provider (shown in the settings dialog; user can override). */
export const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-5"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
};

const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Condensed grammar the model must follow. Mirrors the README. */
const GRAMMAR = `Streusel mini-notation (a clip name → MIDI). Output goes straight into Ableton.

EXPRESSION:
  0 2 4 -1        scale degrees (0 = root; in the project key)
  c3 e3 g3        literal note names
  . or ~          rest
  [a b c]         subdivision — share one step's time
  <a b c>         alternation — one per cycle, wraps
  {a b c}%4       polyrhythm over 4 even slots
  e(3,8)          euclidean rhythm (3 hits / 8 steps)
  [Name]          reference another clip by name
  [A] + [B]       merge two clips
MODIFIERS (suffix an atom): *N repeat, !N elongate, ^N ratchet, ? 50% chance
LEADING FLAG: "n:" makes bare numbers chromatic semitone offsets (breakbeat slicing)
OPERATIONS (pipe with |): rev, sort, shuffle, dedup, add N (scale degrees),
  semitones N, slow N, fast N, take N, skip N, vel V (0–1), gate G (note length,
  1=full <1=staccato), ratchet N, every N:op
SIGNALS (as an op arg): waveforms sine/saw/tri/square/noise with (lo,hi) range,
  rate, "phase P", "skew S" — e.g. "vel sine", "gate saw 2", "add sine(0,7)".
  Feeding a wave into add quantizes it to the scale ("pluck to scale").
CYCLES: append "@N" to set how many cycles render (default 2).

RHYTHM — lean on these for interest, don't just write even note runs:
  [a b] / [a b c]  pack more hits into a step (subdivision, syncopation)
  e(3,8) e(5,8)    euclidean grooves; mix pulse counts across voices
  {a b c}%8        cross-rhythm against the bar
  ~ or .           rests create space and groove
  a*3  a^4         repeats and ratchet rolls (fills, hats)
  !N               hold/accent a step longer
  | gate 0.4       short/stabby vs sustained

EXAMPLES:
  c1 ~ c1 c1 ~ c1 ~ ~ | gate 0.5          syncopated kick
  e(5,8) | gate 0.7 @2                     euclidean groove
  [0 0] ~ 0*3 ~ | vel saw                  subdivided + ratcheted hits
  {c2 e2 g2 a2 b2}%8 | gate 0.6            5-against-8 cross-rhythm
  0 [2 4] 7 <5 9> | rev @4                 nested + alternation
  0*8 | add sine(0,7) | vel tri            wave melody, plucked to scale
  c1^4 ~ c1 ~ c1^2 ~ ~ ~                   ratchet roll fill`;

/** System prompt — teaches the grammar and pins the output format. */
export function buildSystemPrompt(ctx?: KeyContext): string {
  const keyLine = ctx
    ? `\n\nProject context: key ${ROOT_NAMES[ctx.rootNote % 12]}, scale intervals [${ctx.scaleIntervals.join(" ")}], ${Math.round(ctx.bpm)} BPM. Write in this key — prefer scale degrees so it stays in key.`
    : "";
  return `You are a generator for the Streusel pattern language for Ableton Live.${keyLine}

${GRAMMAR}

Rules:
- Output ONLY Streusel patterns, exactly one per line.
- No prose, no commentary, no markdown, no backticks, no numbering.
- Each line must be a complete, valid pattern on its own.
- Prioritise RHYTHM: vary note density with subdivisions, rests, euclidean and
  cross-rhythms, ratchets and accents — avoid flat, evenly-spaced runs unless asked.
- Shape dynamics and articulation with vel and gate so it grooves, not just plays.`;
}

/** User prompt — asks for `count` distinct patterns matching the description. */
export function buildUserPrompt(description: string, count: number): string {
  const n = Math.max(1, Math.round(count));
  return n === 1
    ? `Write one Streusel pattern: ${description}`
    : `Write ${n} distinct Streusel patterns (meaningfully different variations) for: ${description}\nOutput ${n} lines, one pattern each.`;
}

/** Normalize raw model text into candidate pattern lines (strip fences/bullets/backticks). */
export function extractPatterns(text: string): string[] {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(l => !/^```/.test(l))            // drop code-fence lines
    .map(l => l.replace(/^[-*]\s+/, ""))      // bullet markers
    .map(l => l.replace(/^\d+[.)]\s+/, ""))   // "1." / "1)" numbering
    .map(l => l.replace(/`/g, "").trim())     // stray backticks
    .filter(Boolean);
}

/** Heuristic: did an API error message come from a bad/missing/expired key? */
export function isAuthError(message: string): boolean {
  return /\b40[13]\b/.test(message)
    || /unauthor|invalid[_\s-]*api|invalid.*key|authentication|x-api-key|incorrect api key|permission/i.test(message);
}

/** Heuristic: did an API error come from an unknown/unavailable model? */
export function isModelError(message: string): boolean {
  return /model/i.test(message)
    && /(not[_\s-]?found|does not exist|no such|unknown|unavailable|deprecat|\b404\b)/i.test(message);
}

/** Keep only lines that parse as valid Streusel, de-duplicated, preserving order. */
export function validatePatterns(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    let ok = false;
    try { ok = parse(line) !== null; } catch { ok = false; }
    if (ok) { seen.add(line); out.push(line); }
  }
  return out;
}

// ─── Provider router ───────────────────────────────────────────────────────────

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  readText: (json: any) => string;
}

function buildRequest(cfg: LlmConfig, system: string, user: string): ProviderRequest {
  if (cfg.provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: { model: cfg.model, max_tokens: 1024, system, messages: [{ role: "user", content: user }] },
      readText: (j) => (j?.content ?? []).map((b: any) => b?.text ?? "").join(""),
    };
  }
  // openai
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: {
      model: cfg.model,
      max_tokens: 1024,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    },
    readText: (j) => j?.choices?.[0]?.message?.content ?? "",
  };
}

/**
 * Generate up to `count` validated patterns. `fetchImpl` is injectable for testing.
 * Throws on HTTP / network errors; returns [] if nothing the model returned parsed.
 */
export async function generatePatterns(
  cfg: LlmConfig,
  description: string,
  count: number,
  ctx?: KeyContext,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const req = buildRequest(cfg, buildSystemPrompt(ctx), buildUserPrompt(description, count));
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${cfg.provider} API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = req.readText(json);
  return validatePatterns(extractPatterns(text)).slice(0, Math.max(1, Math.round(count)));
}
