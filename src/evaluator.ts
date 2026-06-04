/**
 * Evaluates a parsed Streusel clip expression into NoteDescription[].
 * Pure Node, no Ableton SDK deps except the NoteDescription type.
 */
import type { NoteDescription } from "@ableton-extensions/sdk";
import type { ParsedClip, Expr, Op, Token } from "./parser.js";
import * as Ops from "./ops.js";

export interface ProjectKey {
  rootNote: number;         // 0–11
  scaleIntervals: number[]; // semitone offsets from root
  bpm: number;
}

export interface ClipStore {
  /** Resolve a clip name to its already-evaluated notes (from dependency graph) */
  get(name: string): NoteDescription[] | undefined;
}

const BEATS_PER_CYCLE = 4; // assume 4/4

// ─── Note name → MIDI ────────────────────────────────────────────────────────
const NOTE_MAP: Record<string, number> = {
  c:0, "c#":1, db:1, d:2, "d#":3, eb:3, e:4, f:5,
  "f#":6, gb:6, g:7, "g#":8, ab:8, a:9, "a#":10, bb:10, b:11,
};
function noteNameToMidi(name: string): number {
  const m = name.toLowerCase().match(/^([a-g][#b]?)(-?\d+)$/);
  if (!m) throw new Error(`Bad note: ${name}`);
  const pc = NOTE_MAP[m[1]];
  if (pc === undefined) throw new Error(`Unknown pitch class: ${m[1]}`);
  return pc + (parseInt(m[2]) + 1) * 12;
}

// ─── Scale degree → MIDI ─────────────────────────────────────────────────────
function degreeToMidi(degree: number, key: ProjectKey): number {
  const { rootNote, scaleIntervals } = key;
  const len = scaleIntervals.length;
  const octave = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return 60 + rootNote + (scaleIntervals[idx] ?? 0) + octave * 12;
}

// ─── Token → NoteDescription ─────────────────────────────────────────────────
function tokenToNote(token: Token, startTime: number, duration: number, key: ProjectKey): NoteDescription | null {
  if (token.kind === "rest") return null;
  const pitch = token.kind === "note"
    ? noteNameToMidi(token.name)
    : degreeToMidi(token.value, key);
  return { pitch: Math.max(0, Math.min(127, pitch)), startTime, duration, velocity: 90 };
}

// ─── Expression evaluator ────────────────────────────────────────────────────
function evalExpr(expr: Expr, cycles: number, key: ProjectKey, store: ClipStore): NoteDescription[] {
  const totalBeats = cycles * BEATS_PER_CYCLE;

  switch (expr.type) {
    case "seq": {
      const stepDur = totalBeats / expr.items.length;
      const notes: NoteDescription[] = [];
      expr.items.forEach((token, i) => {
        const note = tokenToNote(token, i * stepDur, stepDur * 0.9, key);
        if (note) notes.push(note);
      });
      return notes;
    }

    case "ref": {
      const resolved = store.get(expr.name);
      if (!resolved) throw new Error(`[${expr.name}] not found — check clip name exists and was evaluated first`);
      return resolved;
    }

    case "merge": {
      const left  = evalExpr(expr.left,  cycles, key, store);
      const right = evalExpr(expr.right, cycles, key, store);
      return Ops.merge(left, right);
    }

    case "euclid": {
      // Default to root note, 1 beat per cycle, 90 velocity
      const pitch = 60 + key.rootNote;
      return Ops.euclid(expr.pulses, expr.steps, totalBeats, pitch, 90);
    }
  }
}

// ─── Apply operations ────────────────────────────────────────────────────────
function applyOp(notes: NoteDescription[], op: Op, cycles: number): NoteDescription[] {
  switch (op.op) {
    case "rev":     return Ops.rev(notes);
    case "sort":    return Ops.sort(notes);
    case "shuffle": return Ops.shuffle(notes);
    case "dedup":   return Ops.dedup(notes);
    case "add":     return Ops.add(notes, op.value);
    case "slow":    return Ops.slow(notes, op.value);
    case "fast":    return Ops.fast(notes, op.value);
    case "take":    return Ops.take(notes, op.value);
    case "skip":    return Ops.skip(notes, op.value);
    case "vel":     return Ops.vel(notes, op.value);
    case "every":
      return Ops.every(notes, op.n, BEATS_PER_CYCLE, (ns) => applyOp(ns, op.inner, 1));
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────────
export function evaluate(parsed: ParsedClip, key: ProjectKey, store: ClipStore): NoteDescription[] {
  let notes = evalExpr(parsed.expr, parsed.cycles, key, store);
  for (const op of parsed.ops) {
    notes = applyOp(notes, op, parsed.cycles);
  }
  // Clamp all pitches just in case transforms pushed out of range
  return notes
    .map(n => ({ ...n, pitch: Math.max(0, Math.min(127, n.pitch ?? 60)) }))
    .filter(n => n.duration > 0);
}
