import type { NoteDescription } from "@ableton-extensions/sdk";
import type { ParsedClip, Weighted, Atom, Op, OpArg } from "./parser.js";
import * as Ops from "./ops.js";

export interface ProjectKey {
  rootNote: number;
  scaleIntervals: number[];
  bpm: number;
}

export interface ClipStore {
  get(name: string): NoteDescription[] | undefined;
}

const BEATS_PER_CYCLE = 4;

// ─── Note name → MIDI ─────────────────────────────────────────────────────────
const PC: Record<string, number> = {
  c:0,"c#":1,db:1,d:2,"d#":3,eb:3,e:4,f:5,"f#":6,gb:6,g:7,"g#":8,ab:8,a:9,"a#":10,bb:10,b:11,
};
function noteToMidi(name: string): number {
  const m = name.toLowerCase().match(/^([a-g][#b]?)(-?\d+)$/);
  if (!m) throw new Error(`Bad note: ${name}`);
  const pc = PC[m[1]];
  if (pc === undefined) throw new Error(`Unknown pitch class: ${m[1]}`);
  return pc + (parseInt(m[2]) + 1) * 12;
}

function degreeToMidi(deg: number, key: ProjectKey): number {
  const { rootNote, scaleIntervals } = key;
  const len = scaleIntervals.length;
  const oct = Math.floor(deg / len);
  const idx = ((deg % len) + len) % len;
  return 60 + rootNote + (scaleIntervals[idx] ?? 0) + oct * 12;
}

// ─── Bjorklund ────────────────────────────────────────────────────────────────
function bjorklund(pulses: number, steps: number): boolean[] {
  if (pulses >= steps) return Array(steps).fill(true);
  if (pulses === 0)    return Array(steps).fill(false);
  let pat: boolean[][] = [
    ...Array(pulses).fill(0).map(() => [true]),
    ...Array(steps - pulses).fill(0).map(() => [false]),
  ];
  let remainder = steps - pulses;
  while (remainder > 1) {
    const groups = Math.min(pulses, remainder);
    const next: boolean[][] = [];
    for (let i = 0; i < groups; i++)
      next.push([...(pat[i] ?? []), ...(pat[pat.length - 1 - i] ?? [])]);
    if (pulses > remainder)
      for (let i = remainder; i < pulses; i++) next.push(pat[i] ?? []);
    else
      for (let i = pulses; i < pat.length - groups; i++) next.push(pat[i] ?? []);
    pulses    = Math.min(pulses, remainder);
    remainder = Math.abs(pat.length - groups * 2);
    pat = next;
  }
  return pat.flat();
}

// ─── Expand *N / !N ───────────────────────────────────────────────────────────
/** Expand a Weighted list: *N → N copies; !N → weight slot (handled in time slice). */
function expand(ws: Weighted[]): Weighted[] {
  const out: Weighted[] = [];
  for (const w of ws) {
    for (let i = 0; i < w.repeat; i++) out.push({ ...w, repeat: 1 });
  }
  return out;
}

/** Total weight of a list (for time distribution). */
function totalWeight(ws: Weighted[]): number {
  return ws.reduce((s, w) => s + w.weight, 0);
}

// ─── Core recursive evaluator ─────────────────────────────────────────────────

function evalAtom(
  atom: Atom,
  startTime: number,
  duration: number,
  cycle: number,
  key: ProjectKey,
  store: ClipStore,
): NoteDescription[] {
  switch (atom.kind) {
    case "note":
      return [{ pitch: clamp(noteToMidi(atom.name), 0, 127), startTime, duration: duration * 0.9, velocity: 90 }];

    case "degree":
      return [{ pitch: clamp(degreeToMidi(atom.value, key), 0, 127), startTime, duration: duration * 0.9, velocity: 90 }];

    case "rest":
      return [];

    case "ref": {
      const src = store.get(atom.name);
      if (!src) throw new Error(`[${atom.name}] not found`);
      // Scale source clip to fit duration
      const srcLen = Ops.totalBeats(src);
      if (srcLen === 0) return [];
      const scale = duration / srcLen;
      return src.map(n => ({
        ...n,
        startTime: startTime + n.startTime * scale,
        duration:  n.duration  * scale,
      }));
    }

    case "seq": {
      const expanded = expand(atom.items);
      const tw = totalWeight(expanded);
      if (tw === 0) return [];
      let t = startTime;
      const notes: NoteDescription[] = [];
      for (const w of expanded) {
        const dur = (w.weight / tw) * duration;
        if (!w.optional || Math.random() < 0.5) {
          notes.push(...evalAtom(w.atom, t, dur, cycle, key, store));
        }
        t += dur;
      }
      return notes;
    }

    case "alt": {
      if (atom.choices.length === 0) return [];
      const choice = atom.choices[cycle % atom.choices.length] ?? [];
      return evalItems(choice, startTime, duration, cycle, key, store);
    }

    case "poly": {
      // Distribute items over `steps` evenly-spaced slots
      const items = expand(atom.items);
      if (items.length === 0 || atom.steps === 0) return [];
      const slotDur = duration / atom.steps;
      const notes: NoteDescription[] = [];
      for (let i = 0; i < atom.steps; i++) {
        const item = items[i % items.length];
        if (!item) continue;
        if (item.optional && Math.random() >= 0.5) continue;
        notes.push(...evalAtom(item.atom, startTime + i * slotDur, slotDur * 0.9, cycle, key, store));
      }
      return notes;
    }

    case "euclid": {
      const pattern = bjorklund(atom.pulses, atom.steps);
      const slotDur = duration / atom.steps;
      const pitch   = clamp(60 + key.rootNote, 0, 127);
      const notes: NoteDescription[] = [];
      pattern.forEach((hit, i) => {
        if (hit) notes.push({ pitch, startTime: startTime + i * slotDur, duration: slotDur * 0.9, velocity: 90 });
      });
      return notes;
    }

    case "merge": {
      const left  = evalItems(atom.left,  startTime, duration, cycle, key, store);
      const right = evalItems(atom.right, startTime, duration, cycle, key, store);
      return Ops.merge(left, right);
    }
  }
}

function evalItems(
  items: Weighted[],
  startTime: number,
  duration: number,
  cycle: number,
  key: ProjectKey,
  store: ClipStore,
): NoteDescription[] {
  const expanded = expand(items);
  const tw = totalWeight(expanded);
  if (tw === 0) return [];
  let t = startTime;
  const notes: NoteDescription[] = [];
  for (const w of expanded) {
    const dur = (w.weight / tw) * duration;
    if (!w.optional || Math.random() < 0.5) {
      notes.push(...evalAtom(w.atom, t, dur, cycle, key, store));
    }
    t += dur;
  }
  return notes;
}

// ─── Pattern arg sampling ─────────────────────────────────────────────────────

/**
 * Sample a numeric value from a Weighted[] pattern at a given beat position.
 * relPos: 0–1 position within the current time span.
 * cycle: which cycle (for alternation <> advancement).
 */
function sampleNumAt(items: Weighted[], relPos: number, cycle: number): number {
  const expanded = expand(items);
  const tw = totalWeight(expanded);
  if (tw === 0) return 0;
  let cum = 0;
  for (const w of expanded) {
    const next = cum + w.weight / tw;
    if (relPos < next || next >= 1 - 1e-9) {
      const inner = (relPos - cum) / (w.weight / tw);
      return atomNumAt(w.atom, inner, cycle);
    }
    cum = next;
  }
  return 0;
}

function atomNumAt(atom: Atom, relPos: number, cycle: number): number {
  switch (atom.kind) {
    case "degree": return atom.value;
    case "rest":   return 0;
    case "seq":    return sampleNumAt(atom.items, relPos, cycle);
    case "alt": {
      const ch = atom.choices[cycle % atom.choices.length] ?? [];
      return sampleNumAt(ch, relPos, cycle);
    }
    default: return 0; // refs, euclid, poly, merge not supported as numeric args
  }
}

/** Resolve an OpArg to a scalar for a specific note's time position. */
function resolveArg(arg: OpArg, note: NoteDescription, totalBeats: number): number {
  if (typeof arg === "number") return arg;
  if (arg === "rand") return Math.floor(40 + Math.random() * 87);
  // Pattern: sample at note's position
  const cycle = Math.floor(note.startTime / BEATS_PER_CYCLE);
  const cyclePos = totalBeats > 0
    ? ((note.startTime % BEATS_PER_CYCLE) / BEATS_PER_CYCLE)
    : 0;
  return sampleNumAt(arg, cyclePos, cycle);
}

// ─── Apply operations ─────────────────────────────────────────────────────────

function applyOp(notes: NoteDescription[], op: Op, totalBeats: number): NoteDescription[] {
  switch (op.op) {
    case "rev":     return Ops.rev(notes);
    case "sort":    return Ops.sort(notes);
    case "shuffle": return Ops.shuffle(notes);
    case "dedup":   return Ops.dedup(notes);
    case "take":    return Ops.take(notes, op.value);
    case "skip":    return Ops.skip(notes, op.value);

    // Scalar ops that support pattern args — sample per note
    case "add":
      return notes.map(n => ({
        ...n, pitch: clamp((n.pitch ?? 60) + Math.round(resolveArg(op.value, n, totalBeats)), 0, 127),
      }));
    case "vel":
      return notes.map(n => {
        const v = resolveArg(op.value, n, totalBeats);
        return { ...n, velocity: clamp(Math.round(v), 1, 127) };
      });
    case "slow": {
      // If pattern arg, treat per-note duration scaling isn't meaningful; fall back to scalar mean
      if (typeof op.value !== "number") return Ops.slow(notes, resolveArg(op.value, notes[0] ?? { startTime: 0, duration: 1, pitch: 60 }, totalBeats));
      return Ops.slow(notes, op.value);
    }
    case "fast": {
      if (typeof op.value !== "number") return Ops.fast(notes, resolveArg(op.value, notes[0] ?? { startTime: 0, duration: 1, pitch: 60 }, totalBeats));
      return Ops.fast(notes, op.value);
    }

    case "every":
      return Ops.every(notes, op.n, BEATS_PER_CYCLE, ns => applyOp(ns, op.inner, totalBeats));
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export function evaluate(parsed: ParsedClip, key: ProjectKey, store: ClipStore): NoteDescription[] {
  // Evaluate cycle by cycle so alternation <> can advance per cycle
  const allNotes: NoteDescription[] = [];
  for (let c = 0; c < parsed.cycles; c++) {
    const cycleNotes = evalItems(
      parsed.items,
      c * BEATS_PER_CYCLE,
      BEATS_PER_CYCLE,
      c,
      key,
      store,
    );
    allNotes.push(...cycleNotes);
  }

  const totalBeats = parsed.cycles * BEATS_PER_CYCLE;
  let notes = allNotes;
  for (const op of parsed.ops) notes = applyOp(notes, op, totalBeats);

  return notes
    .map(n => ({ ...n, pitch: clamp(n.pitch ?? 60, 0, 127) }))
    .filter(n => n.duration > 0.01);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
