/**
 * Streusel mini-notation parser — recursive descent.
 *
 * Clip name format:
 *   <expr> [| <op>]* [@<cycles>]
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
}

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
  items: Weighted[];
  ops: Op[];
  cycles: number;
  refs: string[];
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
    while (!this.eof() && !/[\s\[\]<>{}|@?*!%]/.test(this.peek())) this.pos++;
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
const DEGREE_RE = /^-?[0-9]+$/;

function atomFromWord(word: string, refs: string[]): Atom {
  if (word === "." || word === "~") return { kind: "rest" };
  if (NOTE_RE.test(word))           return { kind: "note",   name: word.toLowerCase() };
  if (DEGREE_RE.test(word))         return { kind: "degree", value: parseInt(word) };
  throw new Error(`Unknown atom: "${word}"`);
}

// ─── Modifier reader (after an atom or closing bracket) ───────────────────────

function readModifiers(sc: Scanner): { repeat: number; weight: number; optional: boolean } {
  let repeat = 1, weight = 1, optional = false;
  while (!sc.eof()) {
    const ch = sc.peek();
    if (ch === "*") {
      sc.pos++;
      repeat = /\d/.test(sc.peek()) ? sc.readInt() : 2;
    } else if (ch === "!") {
      sc.pos++;
      weight = /\d/.test(sc.peek()) ? sc.readInt() : 2;
    } else if (ch === "?") {
      sc.pos++;
      optional = true;
    } else {
      break;
    }
  }
  return { repeat, weight, optional };
}

// ─── Item list parser ─────────────────────────────────────────────────────────

function parseItems(sc: Scanner, stopAt: string, refs: string[]): Weighted[] {
  const items: Weighted[] = [];
  while (!sc.eof()) {
    sc.skipWS();
    const ch = sc.peek();
    if (!ch || stopAt.includes(ch)) break;

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
  return [{ atom: { kind: "merge", left, right }, repeat: 1, weight: 1, optional: false }];
}

// ─── Operation parser (unchanged) ────────────────────────────────────────────

function parseOp(raw: string): Op {
  const [name, arg] = raw.trim().split("=").map(s => s.trim());
  switch ((name ?? "").toLowerCase()) {
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
      const [nStr, ...rest] = (arg ?? "2:rev").split(":");
      return { op: "every", n: parseInt(nStr ?? "2"), inner: parseOp(rest.join(":")) };
    }
    default:
      throw new Error(`Unknown operation: "${name}"`);
  }
}

// ─── Top-level parse ──────────────────────────────────────────────────────────

export function parse(clipName: string): ParsedClip | null {
  let body = clipName.trim();
  if (!body) return null;

  // Strip @N cycle suffix
  let cycles = 2;
  const cycleMatch = body.match(/\s*@(\d+(?:\.\d+)?)\s*$/);
  if (cycleMatch) { cycles = parseFloat(cycleMatch[1]); body = body.slice(0, -cycleMatch[0].length).trim(); }

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

  return { items, ops, cycles, refs };
}
