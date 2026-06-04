/**
 * Streusel clip-name DSL parser.
 *
 * Clip name format:
 *   <expr> [| <op> [=<arg>]]* [@<cycles>]
 *
 * Expressions:
 *   c3 e3 g3              literal note sequence
 *   0 2 4 -1              scale-degree sequence (requires project scale)
 *   [Melody]              reference another clip by name
 *   [A] + [B]             merge (stack) two clips
 *   e(3,8)                euclidean rhythm (3 pulses over 8 steps)
 *
 * Operations (piped with |):
 *   rev                   reverse note order
 *   add=7                 transpose by semitones (or scale degrees before scale map)
 *   slow=2                halve speed (double duration of each note)
 *   fast=2                double speed
 *   every=2:rev           apply op every N cycles
 *   take=4                keep first N notes
 *   skip=2                remove every Nth note
 *   shuffle               randomize order
 *   sort                  sort by pitch ascending
 *   dedup                 remove consecutive duplicates
 *   vel=80                set all velocities
 *   vel=rand              randomize velocities
 */

export type NoteToken = { kind: "note"; name: string };       // "c3", "e4", "g#3"
export type DegreeToken = { kind: "degree"; value: number };  // 0, 2, -1
export type RestToken = { kind: "rest" };                     // "." or "~"

export type SeqExpr   = { type: "seq";   items: Token[] };
export type RefExpr   = { type: "ref";   name: string };
export type MergeExpr = { type: "merge"; left: Expr; right: Expr };
export type EuclidExpr = { type: "euclid"; pulses: number; steps: number };

export type Token = NoteToken | DegreeToken | RestToken;
export type Expr = SeqExpr | RefExpr | MergeExpr | EuclidExpr;

export type Op =
  | { op: "rev" }
  | { op: "sort" }
  | { op: "shuffle" }
  | { op: "dedup" }
  | { op: "add";   value: number }
  | { op: "slow";  value: number }
  | { op: "fast";  value: number }
  | { op: "take";  value: number }
  | { op: "skip";  value: number }
  | { op: "vel";   value: number | "rand" }
  | { op: "every"; n: number; inner: Op };

export interface ParsedClip {
  expr: Expr;
  ops: Op[];
  cycles: number;
  refs: string[];   // all [ClipName] dependencies, for graph building
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

const NOTE_RE = /^[a-gA-G][#b]?[0-9]$/;
const DEG_RE  = /^-?[0-9]+$/;

function tokenize(s: string): Token[] {
  return s.trim().split(/\s+/).filter(Boolean).map(t => {
    if (t === "." || t === "~") return { kind: "rest" } as RestToken;
    if (NOTE_RE.test(t)) return { kind: "note", name: t.toLowerCase() } as NoteToken;
    if (DEG_RE.test(t))  return { kind: "degree", value: parseInt(t) } as DegreeToken;
    throw new Error(`Unknown token: "${t}"`);
  });
}

// ─── Expression parser ───────────────────────────────────────────────────────

function parseExpr(raw: string): { expr: Expr; refs: string[] } {
  const refs: string[] = [];

  // Euclidean: e(3,8)
  const eucMatch = raw.match(/^e\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (eucMatch) {
    return { expr: { type: "euclid", pulses: parseInt(eucMatch[1]), steps: parseInt(eucMatch[2]) }, refs };
  }

  // Merge: [A] + [B] (simple two-operand split)
  const mergeMatch = raw.match(/^(\[.*?\])\s*\+\s*(\[.*?\])$/);
  if (mergeMatch) {
    const left  = parseExpr(mergeMatch[1]);
    const right = parseExpr(mergeMatch[2]);
    return { expr: { type: "merge", left: left.expr, right: right.expr }, refs: [...left.refs, ...right.refs] };
  }

  // Reference: [ClipName]
  const refMatch = raw.match(/^\[(.+)\]$/);
  if (refMatch) {
    const name = refMatch[1].trim();
    refs.push(name);
    return { expr: { type: "ref", name }, refs };
  }

  // Literal sequence
  try {
    const items = tokenize(raw);
    return { expr: { type: "seq", items }, refs };
  } catch (e) {
    throw new Error(`Cannot parse expression: "${raw}" — ${(e as Error).message}`);
  }
}

// ─── Operation parser ────────────────────────────────────────────────────────

function parseOp(raw: string): Op {
  const [name, arg] = raw.trim().split("=").map(s => s.trim());

  switch (name.toLowerCase()) {
    case "rev":     return { op: "rev" };
    case "sort":    return { op: "sort" };
    case "shuffle": return { op: "shuffle" };
    case "dedup":   return { op: "dedup" };
    case "add":     return { op: "add",  value: parseFloat(arg ?? "0") };
    case "slow":    return { op: "slow", value: parseFloat(arg ?? "2") };
    case "fast":    return { op: "fast", value: parseFloat(arg ?? "2") };
    case "take":    return { op: "take", value: parseInt(arg ?? "4") };
    case "skip":    return { op: "skip", value: parseInt(arg ?? "2") };
    case "vel":
      return { op: "vel", value: arg === "rand" ? "rand" : parseInt(arg ?? "90") };
    case "every": {
      // every=2:rev  or  every=2:add=7
      const [nStr, ...rest] = (arg ?? "2:rev").split(":");
      return { op: "every", n: parseInt(nStr), inner: parseOp(rest.join(":")) };
    }
    default:
      throw new Error(`Unknown operation: "${name}"`);
  }
}

// ─── Top-level parse ─────────────────────────────────────────────────────────

export function parse(clipName: string): ParsedClip | null {
  // Skip clips that aren't patterns (no notes, no refs, no euclid)
  const trimmed = clipName.trim();
  if (!trimmed) return null;

  // Extract cycle count suffix: @4
  let cycles = 2;
  let body = trimmed;
  const cycleMatch = body.match(/\s*@(\d+(?:\.\d+)?)\s*$/);
  if (cycleMatch) {
    cycles = parseFloat(cycleMatch[1]);
    body = body.slice(0, -cycleMatch[0].length).trim();
  }

  // Split on | into expr and ops
  const parts = body.split("|").map(p => p.trim());
  const exprStr = parts[0];
  const opStrs  = parts.slice(1);

  // Try to parse — return null if it doesn't look like a pattern
  let expr: Expr;
  let refs: string[] = [];
  try {
    const result = parseExpr(exprStr);
    expr = result.expr;
    refs = result.refs;
  } catch {
    return null; // not a pattern we recognize
  }

  const ops: Op[] = [];
  for (const opStr of opStrs) {
    if (!opStr) continue;
    try {
      ops.push(parseOp(opStr));
    } catch (e) {
      console.warn(`[streusel] skipping unknown op: "${opStr}"`);
    }
  }

  return { expr, ops, cycles, refs };
}
