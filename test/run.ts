/**
 * Streusel test suite — deterministic assertions across the whole language.
 * Run with `npm test` (adds a typecheck) or `tsx test/run.ts` directly.
 *
 * Random features (rand / noise / ? optional / shuffle order) are checked by
 * structural properties (range, multiset, count), never exact values.
 */
import { parse } from "../src/parser.js";
import { evaluate, type ProjectKey, type ClipStore } from "../src/evaluator.js";
import { buildGraph, topoSort, dependents, clipKey, type ClipNode } from "../src/resolver.js";
import { extractPatterns, validatePatterns, buildSystemPrompt, buildUserPrompt, generatePatterns, isAuthError, isModelError, type LlmConfig } from "../src/llm.js";

const KEY: ProjectKey = { rootNote: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], bpm: 120 };
const EMPTY: ClipStore = { get: () => undefined };

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failures.push(detail ? `${name}  — ${detail}` : name);
}

function ev(s: string, store: ClipStore = EMPTY) {
  const p = parse(s);
  if (!p) throw new Error(`parse() returned null for: ${s}`);
  return evaluate(p, KEY, store).slice().sort((a, b) => a.startTime - b.startTime);
}
const pitches = (s: string, store?: ClipStore) => ev(s, store).map(n => n.pitch);
const beats = (s: string) => ev(s).map(n => +n.startTime.toFixed(3));
const durs = (s: string) => ev(s).map(n => +n.duration.toFixed(3));
const vels = (s: string) => ev(s).map(n => n.velocity);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const J = (x: unknown) => JSON.stringify(x);
const sig = (ns: ReturnType<typeof ev>) =>
  ns.slice().sort((a, b) => a.startTime - b.startTime || (a.pitch ?? 0) - (b.pitch ?? 0))
    .map(n => `${n.startTime.toFixed(3)}:${n.pitch}`).join(" ");

// ─── Atoms & pitch ────────────────────────────────────────────────────────────
check("note names → midi", eq(pitches("c3 e3 g3 @1"), [48, 52, 55]), J(pitches("c3 e3 g3 @1")));
check("scale degrees", eq(pitches("0 2 4 @1"), [60, 64, 67]), J(pitches("0 2 4 @1")));
check("negative degree", eq(pitches("-1 0 1 @1"), [59, 60, 62]), J(pitches("-1 0 1 @1")));
check("rest drops a note", ev("0 . 4 @1").length === 2);
check("rest keeps the grid", eq(beats("0 . 4 @1"), [0, 2.667]), J(beats("0 . 4 @1")));

// ─── Structure: subdivision / alt / poly / euclid ──────────────────────────────
check("subdivision pitches", eq(pitches("[0 2] 4 @1"), [60, 64, 67]));
check("subdivision timing", eq(beats("[0 2] 4 @1"), [0, 1, 2]), J(beats("[0 2] 4 @1")));
check("alt advances per cycle", eq(pitches("<0 5> @2"), [60, 69]) && eq(beats("<0 5> @2"), [0, 4]));
check("alt 3-way wraps", eq(pitches("<0 2 4> @3"), [60, 64, 67]), J(pitches("<0 2 4> @3")));
check("polyrhythm %4", eq(pitches("{0 2 4}%4 @1"), [60, 64, 67, 60]) && eq(beats("{0 2 4}%4 @1"), [0, 1, 2, 3]));
check("euclid e(3,8) timing", eq(beats("e(3,8) @1"), [0, 1.5, 3]), J(beats("e(3,8) @1")));
check("euclid uses root pitch", ev("e(3,8) @1").every(n => n.pitch === 60));

// ─── Atom modifiers ────────────────────────────────────────────────────────────
check("repeat *N", eq(beats("0*4 @1"), [0, 1, 2, 3]));
check("elongate !N", eq(beats("0!3 1 @1"), [0, 3]) && eq(pitches("0!3 1 @1"), [60, 62]));
check("ratchet ^N count", ev("0^3 @1").length === 3);
check("optional ? within bounds", ev("0? 2? 4? @1").length <= 3);

// ─── Chromatic flag ────────────────────────────────────────────────────────────
check("n: chromatic offsets", eq(pitches("n: 0 1 2 3 @1"), [60, 61, 62, 63]));
check("default stays in key", eq(pitches("0 1 2 3 @1"), [60, 62, 64, 65]));

// ─── Named patterns + comments ─────────────────────────────────────────────────
check("name = handle parsed, pattern still evaluates", (() => {
  const p = parse("bass = 0 2 4 | rev @4")!;
  return p.name === "bass" && p.cycles === 4 && eq(evaluate(p, KEY, EMPTY).slice(0, 3).map(n => n.pitch), [67, 64, 60]);
})());
check("name combines with n: and @", (() => {
  const p = parse("lead = n: 0 1 2 @1")!;
  return p.name === "lead" && p.chromatic && eq(evaluate(p, KEY, EMPTY).map(n => n.pitch), [60, 61, 62]);
})());
check("; comment is ignored when evaluating", eq(pitches("0 2 4 @1 ;? warm arp"), [60, 64, 67]));
check("comment captured for regeneration", parse("0 2 4 ;? warm arp")?.comment === "? warm arp");
check("named pattern is referenced via its handle", (() => {
  const src = parse("bass = 0 2 4 @1")!;
  const bassNotes = evaluate(src, KEY, EMPTY);
  const store: ClipStore = { get: n => (n === "bass" ? bassNotes : undefined) };
  const lead = parse("[bass] | add 7 @1")!;
  return eq(evaluate(lead, KEY, store).map(n => n.pitch), [72, 76, 79]);
})());

// ─── Resolver with named-pattern handles ───────────────────────────────────────
{
  const clips = [{ name: "bass = 0 2 4 | rev @4" }, { name: "lead = [bass] | add 7" }] as unknown as Parameters<typeof buildGraph>[0];
  const g = buildGraph(clips);
  check("graph keyed by handles", eq([...g.keys()], ["bass", "lead"]));
  check("clipKey returns handle", clipKey("bass = 0 2 4") === "bass" && clipKey("0 2 4") === "0 2 4");
  check("dependents tracks named refs", eq(dependents("bass", g), ["lead"]));
  check("topoSort orders source before dependent", eq(topoSort(g), ["bass", "lead"]));
}

// ─── Operations ────────────────────────────────────────────────────────────────
check("rev = retrograde", eq(pitches("0 2 4 | rev @1"), [67, 64, 60]), J(pitches("0 2 4 | rev @1")));
check("rev mirrors rhythm", eq(beats("[0 2] 4 | rev @1"), [0, 2, 3]), J(beats("[0 2] 4 | rev @1")));
check("sort ascending", eq(pitches("4 0 2 | sort @1"), [60, 64, 67]));
check("dedup consecutive dups", eq(pitches("0 2 0 4 4 | dedup @1"), [60, 64, 60, 67]));
check("take N", eq(pitches("0 2 4 5 6 7 | take 3 @1"), [60, 64, 67]));
check("skip every Nth", eq(pitches("0 2 4 5 6 7 | skip 2 @1"), [60, 67, 71]));
check("add scale degrees", eq(pitches("0 | add 7 @1"), [72]));
check("semitones chromatic", eq(pitches("0 | semitones 7 @1"), [67]));
check("slow stretches", eq(beats("0 2 | slow 2 @1"), [0, 4]));
check("fast count doubles", ev("0 2 4 7 | fast 2 @1").length === 8);
check("every Nth cycle", eq(pitches("0 2 4 7 | every 2:rev @2"), [60, 64, 67, 72, 72, 67, 64, 60]), J(pitches("0 2 4 7 | every 2:rev @2")));
check("merge stacks", ev("[0 2] + [4 7] @1").length === 4);
check("shuffle is a permutation",
  eq(pitches("0 2 4 7 @1").slice().sort((a, b) => a! - b!),
     pitches("0 2 4 7 | shuffle @1").slice().sort((a, b) => a! - b!)));

// ─── Velocity (normalized 0–1) ─────────────────────────────────────────────────
check("vel 0.5 → 64", vels("0*4 | vel 0.5").every(v => v === 64));
check("vel 1 → 127", vels("0*2 | vel 1").every(v => v === 127));
check("vel 0 → 1 (no note-off)", vels("0*2 | vel 0").every(v => v === 1));
check("vel fractional pattern", eq(vels("0*2 | vel [0.2 0.8] @1"), [25, 102]), J(vels("0*2 | vel [0.2 0.8] @1")));

// ─── Gate ──────────────────────────────────────────────────────────────────────
check("default note fills slot", durs("0 2 4 7 @1").every(d => Math.abs(d - 1) < 1e-9));
check("gate halves length", durs("0 2 4 7 | gate 0.5 @1").every(d => Math.abs(d - 0.5) < 1e-9));

// ─── Ratchet × gate × alternation ──────────────────────────────────────────────
check("ratchet fills, gate shortens", durs("0 | ratchet 4 | gate 0.5 @1").every(d => Math.abs(d - 0.5) < 1e-9));
check("ratchet count via <>", ev("0 | ratchet <1 3> @2").length === 4); // cycle0 ×1, cycle1 ×3
check("^N on alt note", ev("<0 5>^2 @2").length === 4);

// ─── Waveforms ─────────────────────────────────────────────────────────────────
check("vel sine within 1..127", vels("0*16 | vel sine").every(v => v! >= 1 && v! <= 127));
check("vel sine actually varies", new Set(vels("0*16 | vel sine")).size > 4);
check("square duty (skew 0.25 → 2/8)", vels("0*8 | vel square 1 skew 0.25").slice(0, 8).filter(v => v === 127).length === 2);
check("rate-1 wave repeats per bar", eq(vels("0*8 | vel tri").slice(0, 8), vels("0*8 | vel tri").slice(8, 16)));
{
  const inKey = new Set([0, 2, 4, 5, 7, 9, 11].flatMap(i => [48 + i, 60 + i, 72 + i]));
  check("add <wave> plucks to scale", pitches("0*16 | add sine(0,7)").every(p => inKey.has(p!)), J([...new Set(pitches("0*16 | add sine(0,7)"))]));
}
{
  const p = pitches("c3*8 | semitones saw(-12,12)").map(x => x!);
  check("wave range maps (saw -12..12)", Math.min(...p) >= 36 && Math.max(...p) <= 60, J([Math.min(...p), Math.max(...p)]));
}

// ─── fast ≡ [X]*N (grid + alternation equivalence) ─────────────────────────────
const FAST_CASES: [string, number, number][] = [
  ["0 2 4 7", 2, 2], ["<0 5> <2 4>", 2, 2], ["0 2 4 7", 4, 1],
  ["[0 2] 4", 2, 2], ["0 e3 7", 3, 2], ["c3 [e3 g3]", 2, 1], ["<0 2 4>", 4, 3],
];
for (const [x, n, cyc] of FAST_CASES) {
  check(`fast≡*N: "${x}" ×${n} @${cyc}`, sig(ev(`${x} | fast ${n} @${cyc}`)) === sig(ev(`[${x}]*${n} @${cyc}`)));
}

// ─── Refs (clip store) ─────────────────────────────────────────────────────────
{
  const src = [
    { pitch: 60, startTime: 0, duration: 1, velocity: 90 },
    { pitch: 64, startTime: 1, duration: 1, velocity: 90 },
  ];
  const store: ClipStore = { get: n => (n === "Src" ? src : undefined) };
  check("ref scaled into slot", eq(pitches("[Src] @1", store), [60, 64]));
  check("ref + op composes", eq(pitches("[Src] | add 7 @1", store), [72, 76]));
}

// ─── Resolver (dependency graph) ───────────────────────────────────────────────
{
  const clips = [
    { name: "0 2 4" },
    { name: "[Melody] | rev" },
    { name: "Melody" }, // not a pattern → excluded from graph, valid ref target
  ] as unknown as Parameters<typeof buildGraph>[0];
  const graph = buildGraph(clips);
  check("buildGraph filters non-patterns", graph.size === 2, `size=${graph.size}`);
  check("refs captured", (graph.get("[Melody] | rev") as ClipNode | undefined)?.refs.join() === "Melody");
  check("dependents finds referrers", dependents("Melody", graph).includes("[Melody] | rev"));
  check("topoSort returns all nodes", topoSort(graph).length === 2);
}

// ─── LLM generation (pure helpers + mocked provider) ───────────────────────────
check("extractPatterns strips fences/bullets/numbering", eq(
  extractPatterns("```\n- 0 2 4\n1. c3 e3 g3\n`0 2 | rev`\n```"),
  ["0 2 4", "c3 e3 g3", "0 2 | rev"]), J(extractPatterns("```\n- 0 2 4\n1. c3 e3 g3\n`0 2 | rev`\n```")));
check("validatePatterns keeps only parseable, dedups", eq(
  validatePatterns(["0 2 4 | rev", "Here are patterns:", "0 2 4 | rev", "c3 e3 g3"]),
  ["0 2 4 | rev", "c3 e3 g3"]));
check("system prompt teaches grammar + key", (() => {
  const sp = buildSystemPrompt({ rootNote: 2, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], bpm: 128 });
  return sp.includes("Streusel") && sp.includes("ratchet") && sp.includes("D") && sp.includes("128");
})());
check("user prompt asks for N variations", buildUserPrompt("warm arp", 3).includes("3 distinct"));
{
  // Mocked provider response — no network. Exercises the Anthropic + OpenAI routers.
  const okText = "Here you go:\n```\n- 0 2 4 7 | rev @4\nnot a pattern!!\nc3 e3 g3 | gate 0.5\n```";
  const mkFetch = (provider: "anthropic" | "openai") => (async (_url: string, init: any) => {
    const sent = JSON.parse(init.body);
    const payload = provider === "anthropic"
      ? { content: [{ text: okText }] }
      : { choices: [{ message: { content: okText } }] };
    // sanity: each provider sends the right shape
    const shapeOk = provider === "anthropic" ? !!sent.system : sent.messages?.[0]?.role === "system";
    return { ok: true, status: 200, json: async () => payload, text: async () => "", _shapeOk: shapeOk } as any;
  }) as unknown as typeof fetch;

  const cfgA: LlmConfig = { provider: "anthropic", model: "m", apiKey: "k" };
  const cfgO: LlmConfig = { provider: "openai", model: "m", apiKey: "k" };
  const a = await generatePatterns(cfgA, "warm arp", 5, undefined, mkFetch("anthropic"));
  const o = await generatePatterns(cfgO, "warm arp", 5, undefined, mkFetch("openai"));
  check("anthropic router returns only valid patterns", eq(a, ["0 2 4 7 | rev @4", "c3 e3 g3 | gate 0.5"]), J(a));
  check("openai router returns only valid patterns", eq(o, ["0 2 4 7 | rev @4", "c3 e3 g3 | gate 0.5"]), J(o));

  // HTTP error surfaces
  const errFetch = (async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "bad key" }) as any) as unknown as typeof fetch;
  let threw = false;
  try { await generatePatterns(cfgA, "x", 1, undefined, errFetch); } catch (e) { threw = (e as Error).message.includes("401"); }
  check("HTTP error throws with status", threw);
}
check("isAuthError detects key failures, not other errors",
  isAuthError("anthropic API 401: invalid x-api-key") &&
  isAuthError("Incorrect API key provided") &&
  isAuthError("openai API 403: permission denied") &&
  !isAuthError("network timeout") &&
  !isAuthError("openai API 500: internal server error"));
check("isModelError detects unknown models, not key/other errors",
  isModelError("anthropic API 404: model: claude-x not_found_error") &&
  isModelError("The model `gpt-foo` does not exist") &&
  !isModelError("401 invalid x-api-key") &&
  !isModelError("network timeout"));

// ─── Report ────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length) {
  console.log(`\n✗ ${failures.length}/${total} FAILED:`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  console.log("");
  process.exit(1);
}
console.log(`\n✓ all ${total} checks pass`);
