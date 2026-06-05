import type { NoteDescription } from "@ableton-extensions/sdk";
import type { ParsedClip, Weighted, Atom, Op, OpArg, Wave } from "./parser.js";
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

/**
 * Default note gate: fraction of each slot a note occupies.
 * 1.0 = fill the slot exactly (even spread, no gaps, no hangover into the next note).
 * Override per-clip with `| gate G` (e.g. `| gate 0.5` for staccato).
 */
const DEFAULT_GATE = 1.0;

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
  chromatic: boolean,
): NoteDescription[] {
  switch (atom.kind) {
    case "note":
      return [{ pitch: clamp(noteToMidi(atom.name), 0, 127), startTime, duration: duration * DEFAULT_GATE, velocity: 90 }];

    case "degree": {
      // degree values may be fractional (op-arg patterns); round when used as a pitch.
      const v = Math.round(atom.value);
      // chromatic mode: number is a semitone offset from the root; else a scale degree
      const pitch = chromatic ? 60 + key.rootNote + v : degreeToMidi(v, key);
      return [{ pitch: clamp(pitch, 0, 127), startTime, duration: duration * DEFAULT_GATE, velocity: 90 }];
    }

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
          let sub = evalAtom(w.atom, t, dur, cycle, key, store, chromatic);
          if (w.ratchet > 1) sub = Ops.ratchet(sub, w.ratchet);
          notes.push(...sub);
        }
        t += dur;
      }
      return notes;
    }

    case "alt": {
      if (atom.choices.length === 0) return [];
      const choice = atom.choices[cycle % atom.choices.length] ?? [];
      return evalItems(choice, startTime, duration, cycle, key, store, chromatic);
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
        let sub = evalAtom(item.atom, startTime + i * slotDur, slotDur, cycle, key, store, chromatic);
        if (item.ratchet > 1) sub = Ops.ratchet(sub, item.ratchet);
        notes.push(...sub);
      }
      return notes;
    }

    case "euclid": {
      const pattern = bjorklund(atom.pulses, atom.steps);
      const slotDur = duration / atom.steps;
      const pitch   = clamp(60 + key.rootNote, 0, 127);
      const notes: NoteDescription[] = [];
      pattern.forEach((hit, i) => {
        if (hit) notes.push({ pitch, startTime: startTime + i * slotDur, duration: slotDur * DEFAULT_GATE, velocity: 90 });
      });
      return notes;
    }

    case "merge": {
      const left  = evalItems(atom.left,  startTime, duration, cycle, key, store, chromatic);
      const right = evalItems(atom.right, startTime, duration, cycle, key, store, chromatic);
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
  chromatic: boolean,
): NoteDescription[] {
  const expanded = expand(items);
  const tw = totalWeight(expanded);
  if (tw === 0) return [];
  let t = startTime;
  const notes: NoteDescription[] = [];
  for (const w of expanded) {
    const dur = (w.weight / tw) * duration;
    if (!w.optional || Math.random() < 0.5) {
      let sub = evalAtom(w.atom, t, dur, cycle, key, store, chromatic);
      if (w.ratchet > 1) sub = Ops.ratchet(sub, w.ratchet);
      notes.push(...sub);
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

const frac = (x: number): number => x - Math.floor(x);

/**
 * Sample a waveform at a note's position. Phase advances continuously across the
 * whole clip (in bars), so the LFO is smooth from cycle to cycle. Returns a value
 * in the wave's [lo, hi] range.
 */
function evalWave(w: Wave, note: NoteDescription): number {
  const t = frac((note.startTime / BEATS_PER_CYCLE) * w.rate + w.phase); // 0..1 in period
  const s = clamp(w.skew, 1e-4, 1 - 1e-4);
  let u: number; // 0..1 unipolar
  switch (w.shape) {
    case "sine":   u = 0.5 - 0.5 * Math.cos(2 * Math.PI * t); break;       // starts at 0, smooth
    case "saw":    u = Math.pow(t, Math.tan(s * Math.PI / 2)); break;       // skew bends the ramp
    case "isaw":   u = 1 - t; break;
    case "tri":    u = t < s ? t / s : (1 - t) / (1 - s); break;            // skew = peak position
    case "square": u = t < s ? 1 : 0; break;                               // skew = duty cycle
    case "noise":  u = Math.random(); break;
    default:       u = 0;
  }
  return w.lo + u * (w.hi - w.lo);
}

/** Resolve an OpArg to a scalar for a specific note's time position. */
function resolveArg(arg: OpArg, note: NoteDescription, totalBeats: number): number {
  if (typeof arg === "number") return arg;
  if (arg === "rand") return Math.random();              // normalized 0–1
  if (!Array.isArray(arg)) return evalWave(arg, note);   // Wave signal
  const cycle = Math.floor(note.startTime / BEATS_PER_CYCLE);
  const cyclePos = totalBeats > 0
    ? ((note.startTime % BEATS_PER_CYCLE) / BEATS_PER_CYCLE)
    : 0;
  return sampleNumAt(arg, cyclePos, cycle);
}

/**
 * Add N scale degrees to a MIDI note — stays in key.
 * Notes not exactly on a scale degree snap to nearest before shifting.
 */
function addDegrees(midi: number, n: number, key: ProjectKey): number {
  const { rootNote, scaleIntervals } = key;
  const len = scaleIntervals.length;
  const rel = midi - 60 - rootNote;
  const oct = Math.floor(rel / 12);
  const semi = ((rel % 12) + 12) % 12;
  // Find nearest scale degree index in current octave
  let deg = 0, bestDist = 13;
  scaleIntervals.forEach((s, i) => {
    const d = Math.abs(s - semi);
    if (d < bestDist) { bestDist = d; deg = i; }
  });
  const absDeg = oct * len + deg + Math.round(n);
  return degreeToMidi(absDeg, key);
}

// ─── Apply operations ─────────────────────────────────────────────────────────

function applyOp(notes: NoteDescription[], op: Op, totalBeats: number, key: ProjectKey): NoteDescription[] {
  switch (op.op) {
    case "rev":     return Ops.rev(notes);
    case "sort":    return Ops.sort(notes);
    case "shuffle": return Ops.shuffle(notes);
    case "dedup":   return Ops.dedup(notes);
    case "take":    return Ops.take(notes, op.value);
    case "skip":    return Ops.skip(notes, op.value);

    // add = scale-degree arithmetic (stays in key); semitones = chromatic
    case "add":
      return notes.map(n => ({
        ...n, pitch: clamp(addDegrees(n.pitch ?? 60, resolveArg(op.value, n, totalBeats), key), 0, 127),
      }));
    case "semitones":
      return notes.map(n => ({
        ...n, pitch: clamp((n.pitch ?? 60) + Math.round(resolveArg(op.value, n, totalBeats)), 0, 127),
      }));
    case "vel":
      // Velocity args are normalized 0–1 (so 0.5 → 64); scaled to MIDI 1–127.
      return notes.map(n => {
        const v = resolveArg(op.value, n, totalBeats);
        return { ...n, velocity: clamp(Math.round(v * 127), 1, 127) };
      });
    case "gate":
      // Scale each note's length: <1 shortens (gaps/staccato), 1 fills the slot, >1 overlaps.
      return notes.map(n => {
        const g = resolveArg(op.value, n, totalBeats);
        return { ...n, duration: Math.max(0.001, n.duration * g) };
      });
    case "ratchet": {
      if (typeof op.value === "number" || op.value === "rand") return Ops.ratchet(notes, op.value);
      // Pattern arg: resolve a per-note count (e.g. ratchet <1 4> alternates per cycle)
      return notes.flatMap(n => Ops.ratchet([n], Math.max(1, Math.round(resolveArg(op.value, n, totalBeats)))));
    }
    case "slow": {
      // If pattern arg, treat per-note duration scaling isn't meaningful; fall back to scalar mean
      if (typeof op.value !== "number") return Ops.slow(notes, resolveArg(op.value, notes[0] ?? { startTime: 0, duration: 1, pitch: 60 }, totalBeats));
      return Ops.slow(notes, op.value);
    }
    case "fast": {
      const f = typeof op.value === "number"
        ? op.value
        : resolveArg(op.value, notes[0] ?? { startTime: 0, duration: 1, pitch: 60 }, totalBeats);
      return Ops.fast(notes, f, BEATS_PER_CYCLE);
    }

    case "every":
      return Ops.every(notes, op.n, BEATS_PER_CYCLE, ns => applyOp(ns, op.inner, totalBeats, key));
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
      parsed.chromatic,
    );
    allNotes.push(...cycleNotes);
  }

  const totalBeats = parsed.cycles * BEATS_PER_CYCLE;
  let notes = allNotes;
  for (const op of parsed.ops) notes = applyOp(notes, op, totalBeats, key);

  return notes
    .map(n => ({ ...n, pitch: clamp(n.pitch ?? 60, 0, 127) }))
    .filter(n => n.duration > 0.01);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
