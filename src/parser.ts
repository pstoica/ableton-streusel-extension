/**
 * Streusel mini-notation parser — recursive descent.
 *
 * Clip name format:
 *   [name =] [n:] <expr> [| <op>]* [@<cycles>] [; comment]
 *
 * Named patterns:  bass = 0 2 4 | rev   → reference the live pattern elsewhere as [bass]
 * Comments:        0 2 4 ; warm bass    → text after `;` is ignored (used to retain prompts)
 *
 * Leading flag:
 *   n:              chromatic mode — bare numbers are semitone offsets from the
 *                   project root (0 → MIDI 60+root), not scale degrees. Good for
 *                   breakbeat slicing / chromatic sampler triggering.
 *
 * Expression atoms:
 *   c3 e3 g3        literal notes
 *   0 2 4 -1        scale degrees
 *   . ~             rest
 *   [a b c]         subdivision — a, b, c share one step's duration
 *   <a b c>         alternation — cycle 0→a, cycle 1→b, cycle 2→c, wraps
 *   {a b c}%N       polyrhythm — play pattern a,b,c over N evenly-spaced slots
 *   e(3,8)          euclidean shorthand
 *   [Ref]           reference another clip by name
 *   [A] + [B]       merge two clips
 *
 * Atom modifiers (append directly to an atom or closing bracket):
 *   *N              repeat N times within the current subdivision
 *   !N  or  !       elongate — atom takes N weight slots (default 2 if bare !)
 *   ?               optional — 50% chance of playing each evaluation
 *   ^N  or  ^        ratchet — retrigger atom N rapid hits in its slot (default 2)
 */

// ─── AST types ────────────────────────────────────────────────────────────────

export type NoteAtom   = { kind: "note";   name: string };
export type DegreeAtom = { kind: "degree"; value: number };
export type RestAtom   = { kind: "rest" };
export type RefAtom    = { kind: "ref";    name: string };
export type SeqAtom    = { kind: "seq";    items: Weighted[] }; // [...]
export type AltAtom    = { kind: "alt";    choices: Weighted[][] }; // <...>
export type PolyAtom   = { kind: "poly";   items: Weighted[]; steps: number }; // {...}%N
export type EuclidAtom = { kind: "euclid"; pulses: number; steps: number };
export type MergeAtom  = { kind: "merge";  left: Weighted[]; right: Weighted[] };

export type Atom = NoteAtom | DegreeAtom | RestAtom | RefAtom
                | SeqAtom | AltAtom | PolyAtom | EuclidAtom | MergeAtom;

export interface Weighted {
  atom: Atom;
  repeat: number;   // *N  — expand to N copies (default 1)
  weight: number;   // !N  — this atom takes N time slots (default 1)
  optional: boolean;// ?   — 50% chance of playing
  ratchet: number;  // ^N  — retrigger N rapid hits within the slot (default 1)
}

// A continuous signal source (LFO), sampled per note by its position in the clip.
// Output is mapped into [lo, hi] (default 0–1). `rate` = cycles per bar, `phase` =
// 0–1 offset, `skew` = shape skew / pulse-width (0–1, default 0.5).
export type WaveShape = "sine" | "saw" | "isaw" | "tri" | "square" | "noise";
export interface Wave {
  kind: "wave";
  shape: WaveShape;
  lo: number;
  hi: number;
  rate: number;
  phase: number;
  skew: number;
}

// Op argument: scalar, "rand", a Weighted[] pattern, or a Wave signal — all
// sampled per-note by the note's time position.
export type OpArg = number | "rand" | Weighted[] | Wave;

export type Op =
  | { op: "rev" }
  | { op: "sort" }
  | { op: "shuffle" }
  | { op: "dedup" }
  | { op: "add";      value: OpArg }  // scale-degree shift (stays in key)
  | { op: "semitones"; value: OpArg } // chromatic semitone shift
  | { op: "slow";  value: OpArg }
  | { op: "fast";  value: OpArg }
  | { op: "take";  value: number }
  | { op: "skip";  value: number }
  | { op: "vel";   value: OpArg }
  | { op: "gate";  value: OpArg }  // scale note length: 1 = fill slot, <1 = staccato, >1 = overlap
  | { op: "ratchet"; value: OpArg }
  | { op: "every"; n: number; inner: Op };

export interface ParsedClip {
  items: Weighted[];
  ops: Op[];
  cycles: number;
  refs: string[];
  chromatic: boolean;  // `n:` prefix — bare numbers are chromatic semitone offsets, not scale degrees
  name?: string | undefined;     // `name = …` handle — lets other clips reference this live pattern via [name]
  comment?: string | undefined;  // `; …` trailing comment (e.g. the generating prompt); ignored when evaluating
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

class Scanner {
  pos = 0;
  constructor(public src: string) {}

  peek(): string { return this.src[this.pos] ?? ""; }
  eof(): boolean { return this.pos >= this.src.length; }
  skipWS(): void { while (!this.eof() && /\s/.test(this.peek())) this.pos++; }

  eat(ch: string): void {
    if (this.src[this.pos] !== ch) throw new Error(`Expected '${ch}' at ${this.pos}`);
    this.pos++;
  }

  readWord(): string {
    const start = this.pos;
    while (!this.eof() && !/[\s\[\]<>{}|@?*!%^]/.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }

  readInt(): number {
    const start = this.pos;
    if (this.peek() === "-") this.pos++;
    while (!this.eof() && /\d/.test(this.peek())) this.pos++;
    return parseInt(this.src.slice(start, this.pos));
  }

  readFloat(): number {
    const start = this.pos;
    if (this.peek() === "-") this.pos++;
    while (!this.eof() && /[\d.]/.test(this.peek())) this.pos++;
    return parseFloat(this.src.slice(start, this.pos));
  }
}

// ─── Note / degree recognition ────────────────────────────────────────────────

const NOTE_RE   = /^[a-gA-G][#b]?-?[0-9]$/;
// Degrees may be fractional so they double as op-arg pattern values (e.g. vel [0.2 0.8]).
// Pitch evaluation rounds; numeric op-args keep the fraction.
const DEGREE_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

function atomFromWord(word: string, refs: string[]): Atom {
  if (word === "." || word === "~") return { kind: "rest" };
  if (NOTE_RE.test(word))           return { kind: "note",   name: word.toLowerCase() };
  if (DEGREE_RE.test(word))         return { kind: "degree", value: parseFloat(word) };
  throw new Error(`Unknown atom: "${word}"`);
}

// ─── Modifier reader (after an atom or closing bracket) ───────────────────────

function readModifiers(sc: Scanner): { repeat: number; weight: number; optional: boolean; ratchet: number } {
  let repeat = 1, weight = 1, optional = false, ratchet = 1;
  while (!sc.eof()) {
    const ch = sc.peek();
    if (ch === "*") {
      sc.pos++;
      repeat = /\d/.test(sc.peek()) ? sc.readInt() : 2;
    } else if (ch === "!") {
      sc.pos++;
      weight = /\d/.test(sc.peek()) ? sc.readInt() : 2;
    } else if (ch === "^") {
      sc.pos++;
      ratchet = /\d/.test(sc.peek()) ? sc.readInt() : 2;
    } else if (ch === "?") {
      sc.pos++;
      optional = true;
    } else {
      break;
    }
  }
  return { repeat, weight, optional, ratchet };
}

// ─── Item list parser ─────────────────────────────────────────────────────────

function parseItems(sc: Scanner, stopAt: string, refs: string[]): Weighted[] {
  const items: Weighted[] = [];
  // Whether whitespace itself is a stop character (e.g. inside <> choices)
  const stopAtWS = stopAt.includes(" ") || stopAt.includes("\t") || stopAt.includes("\n");
  while (!sc.eof()) {
    // Only skip whitespace if it's not a designated stop character
    if (!stopAtWS) sc.skipWS();
    const ch = sc.peek();
    if (!ch || stopAt.includes(ch) || (stopAtWS && /\s/.test(ch))) break;

    let atom: Atom;

    if (ch === "[") {
      sc.pos++;
      // Could be [Ref] or [a b c]
      sc.skipWS();
      // peek ahead to check for Ref pattern: [Word] where Word has no spaces before ]
      const savedPos = sc.pos;
      let bracketContent = "";
      let depth = 0;
      for (let i = sc.pos; i < sc.src.length; i++) {
        if (sc.src[i] === "[") depth++;
        else if (sc.src[i] === "]") { if (depth === 0) { bracketContent = sc.src.slice(sc.pos, i); break; } depth--; }
      }
      const trimmed = bracketContent.trim();
      // Detect ref: no spaces, not a number or note, not containing inner brackets
      const isRef = !trimmed.includes(" ") && !trimmed.includes("[") && !/^[a-gA-G][#b]?-?[0-9]$/.test(trimmed) && !/^-?[0-9]+$/.test(trimmed) && trimmed !== "." && trimmed !== "~";
      if (isRef) {
        sc.pos += bracketContent.length;
        sc.eat("]");
        refs.push(trimmed);
        atom = { kind: "ref", name: trimmed };
      } else {
        const sub = parseItems(sc, "]", refs);
        sc.eat("]");
        atom = { kind: "seq", items: sub };
      }
    } else if (ch === "<") {
      sc.pos++;
      // Each whitespace-separated group is one choice
      const choices: Weighted[][] = [];
      while (!sc.eof() && sc.peek() !== ">") {
        sc.skipWS();
        if (sc.peek() === ">") break;
        // A single "choice" can be a bracketed group or a single atom
        const choice = parseItems(sc, " \t\n>", refs);
        if (choice.length > 0) choices.push(choice);
        sc.skipWS();
      }
      sc.eat(">");
      atom = { kind: "alt", choices };
    } else if (ch === "{") {
      sc.pos++;
      const sub = parseItems(sc, "}", refs);
      sc.eat("}");
      let steps = sub.length;
      if (sc.peek() === "%") {
        sc.pos++;
        steps = sc.readInt();
      }
      atom = { kind: "poly", items: sub, steps };
    } else if (ch === "e" && sc.src[sc.pos + 1] === "(") {
      // e(3,8) euclidean shorthand
      sc.pos += 2;
      const pulses = sc.readInt();
      if (sc.peek() === ",") sc.pos++;
      const steps = sc.readInt();
      sc.eat(")");
      atom = { kind: "euclid", pulses, steps };
    } else {
      const word = sc.readWord();
      if (!word) { sc.pos++; continue; } // skip unknown chars
      atom = atomFromWord(word, refs);
    }

    const mods = readModifiers(sc);
    items.push({ atom, ...mods });
  }
  return items;
}

// ─── Check for merge pattern [A] + [B] ───────────────────────────────────────

function detectMerge(raw: string, refs: string[]): Weighted[] | null {
  const m = raw.match(/^(\[[^\]]+\])\s*\+\s*(\[[^\]]+\])$/);
  if (!m) return null;
  const sc1 = new Scanner(m[1] as string), sc2 = new Scanner(m[2] as string);
  const left  = parseItems(sc1, "", refs);
  const right = parseItems(sc2, "", refs);
  return [{ atom: { kind: "merge", left, right }, repeat: 1, weight: 1, optional: false, ratchet: 1 }];
}

// ─── Operation parser (unchanged) ────────────────────────────────────────────

const WAVE_SHAPES: Record<string, WaveShape> = {
  sine: "sine", sin: "sine",
  saw: "saw", ramp: "saw",
  isaw: "isaw",
  tri: "tri", triangle: "tri",
  square: "square", sqr: "square", pulse: "square",
  noise: "noise", perlin: "noise",
};

/**
 * Parse a waveform op-arg, else null.
 *   sine | saw(-12,12) | tri 2 | square 4 phase 0.25 skew 0.3 | noise(0.3,1)
 * Shape (optionally with a (lo,hi) range) comes first; then in any order a bare
 * number (rate, cycles/bar), `phase <n>`, and `skew <n>`.
 */
function parseWave(arg: string): Wave | null {
  const s = arg.trim();
  // shape, optionally followed by a (lo, hi) range — spaces around the parens and
  // comma are tolerated: `sine(-12,12)`, `sine( -12 , 12 )`, `saw (0, 7)` all work.
  const head = s.match(/^([a-zA-Z]+)\s*(?:\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\))?/);
  if (!head) return null;
  const shape = WAVE_SHAPES[head[1]!.toLowerCase()];
  if (!shape) return null;
  const wave: Wave = {
    kind: "wave", shape,
    lo: head[2] !== undefined ? parseFloat(head[2]) : 0,
    hi: head[3] !== undefined ? parseFloat(head[3]) : 1,
    rate: 1, phase: 0, skew: 0.5,
  };
  // remaining tokens: a bare number (rate), `phase <n>`, `skew <n>` in any order
  const rest = s.slice(head[0].length).trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!.toLowerCase();
    if (t === "phase" && rest[i + 1] !== undefined) wave.phase = parseFloat(rest[++i]!);
    else if (t === "skew" && rest[i + 1] !== undefined) wave.skew = parseFloat(rest[++i]!);
    else if (/^-?\d*\.?\d+$/.test(t)) wave.rate = parseFloat(t);
  }
  return wave;
}

/** Parse an op argument: number, "rand", a waveform, or a mini-notation pattern. */
function parseOpArg(arg: string | undefined, defaultNum: number): OpArg {
  if (!arg) return defaultNum;
  if (arg === "rand") return "rand";
  // Plain number?
  if (/^-?\d+(\.\d+)?$/.test(arg)) return parseFloat(arg);
  // Waveform / continuous signal?
  const wave = parseWave(arg);
  if (wave) return wave;
  // Otherwise try parsing as a mini-notation pattern of numbers
  try {
    const sc = new Scanner(arg);
    const items = parseItems(sc, "", []);
    return items.length > 0 ? items : defaultNum;
  } catch {
    return parseFloat(arg) || defaultNum;
  }
}

function parseOp(raw: string): Op {
  // Support both "add=<0 7>" and "add <0 7>" (= or space as separator)
  // We can't just split on = since the arg might contain = inside patterns (unlikely but safe to handle)
  // Split on first = or first whitespace
  const trimmed = raw.trim();
  const eqIdx = trimmed.indexOf("=");
  const spIdx = trimmed.search(/\s/);
  let name: string, argStr: string | undefined;
  if (eqIdx > 0 && (spIdx < 0 || eqIdx <= spIdx)) {
    name   = trimmed.slice(0, eqIdx).trim();
    argStr = trimmed.slice(eqIdx + 1).trim();
  } else if (spIdx > 0) {
    name   = trimmed.slice(0, spIdx).trim();
    argStr = trimmed.slice(spIdx).trim();
  } else {
    name = trimmed;
  }

  switch (name.toLowerCase()) {
    case "rev":     return { op: "rev" };
    case "sort":    return { op: "sort" };
    case "shuffle": return { op: "shuffle" };
    case "dedup":   return { op: "dedup" };
    case "add":       return { op: "add",       value: parseOpArg(argStr, 0) };
    case "semitones": return { op: "semitones", value: parseOpArg(argStr, 0) };
    case "slow":    return { op: "slow", value: parseOpArg(argStr, 2) };
    case "fast":    return { op: "fast", value: parseOpArg(argStr, 2) };
    case "take":    return { op: "take", value: parseInt(argStr ?? "4") };
    case "skip":    return { op: "skip", value: parseInt(argStr ?? "2") };
    case "vel":     return { op: "vel",  value: parseOpArg(argStr ?? "rand", 90) };
    case "gate":
    case "len":     return { op: "gate", value: parseOpArg(argStr, 0.5) };
    case "ratchet": return { op: "ratchet", value: parseOpArg(argStr, 2) };
    case "every": {
      const colonIdx = (argStr ?? "").indexOf(":");
      const nStr = colonIdx >= 0 ? argStr!.slice(0, colonIdx) : argStr ?? "2";
      const rest = colonIdx >= 0 ? argStr!.slice(colonIdx + 1) : "rev";
      return { op: "every", n: parseInt(nStr), inner: parseOp(rest) };
    }
    default:
      throw new Error(`Unknown operation: "${name}"`);
  }
}

// ─── Top-level parse ──────────────────────────────────────────────────────────

export function parse(clipName: string): ParsedClip | null {
  let body = clipName.trim();
  if (!body) return null;

  // Strip trailing `; comment` (retains the generating prompt; ignored when evaluating)
  let comment: string | undefined;
  const ci = body.indexOf(";");
  if (ci >= 0) { comment = body.slice(ci + 1).trim() || undefined; body = body.slice(0, ci).trim(); }
  if (!body) return null;

  // Leading `name = …` handle → other clips can reference this live pattern via [name]
  let name: string | undefined;
  const nameMatch = body.match(/^([A-Za-z_][\w-]*)\s*=\s*/);
  if (nameMatch) { name = nameMatch[1]; body = body.slice(nameMatch[0].length).trim(); }

  // Strip @N cycle suffix
  let cycles = 2;
  const cycleMatch = body.match(/\s*@(\d+(?:\.\d+)?)\s*$/);
  if (cycleMatch) { cycles = parseFloat(cycleMatch[1]); body = body.slice(0, -cycleMatch[0].length).trim(); }

  // Leading `n:` flag → chromatic numbering (bare numbers are semitone offsets, not scale degrees)
  let chromatic = false;
  const chromMatch = body.match(/^n:\s*/i);
  if (chromMatch) { chromatic = true; body = body.slice(chromMatch[0].length).trim(); }

  // Split on | into expression and ops
  const parts = body.split("|").map(p => p.trim());
  const exprStr = parts[0] ?? "";
  const opStrs  = parts.slice(1);

  const refs: string[] = [];

  // Try merge first
  let items = detectMerge(exprStr, refs);
  if (!items) {
    try {
      const sc = new Scanner(exprStr);
      items = parseItems(sc, "", refs);
    } catch {
      return null; // not a pattern we recognize
    }
  }

  if (items.length === 0) return null;

  const ops: Op[] = [];
  for (const opStr of opStrs) {
    if (!opStr) continue;
    try { ops.push(parseOp(opStr)); }
    catch (e) { console.warn(`[streusel] skipping op: "${opStr}"`); }
  }

  return { items, ops, cycles, refs, chromatic, name, comment };
}
