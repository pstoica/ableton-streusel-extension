/**
 * Pure MIDI operations — all functions take NoteDescription[] and return NoteDescription[].
 * No Ableton SDK imports, fully testable in Node.
 */
import type { NoteDescription } from "@ableton-extensions/sdk";

type Notes = NoteDescription[];

/** Reverse note order, preserving total duration */
export function rev(notes: Notes): Notes {
  const total = totalBeats(notes);
  return [...notes].reverse().map((n, i) => {
    const orig = notes[notes.length - 1 - i];
    return { ...n, startTime: orig.startTime };
  });
}

/** Sort by pitch ascending */
export function sort(notes: Notes): Notes {
  const times = notes.map(n => n.startTime);
  return [...notes]
    .sort((a, b) => (a.pitch ?? 0) - (b.pitch ?? 0))
    .map((n, i) => ({ ...n, startTime: times[i] ?? 0 }));
}

/** Fisher-Yates shuffle, preserving timing grid */
export function shuffle(notes: Notes): Notes {
  const times = notes.map(n => n.startTime);
  const pitches = notes.map(n => n.pitch);
  for (let i = pitches.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pitches[i], pitches[j]] = [pitches[j] as number, pitches[i] as number];
  }
  return notes.map((n, i) => ({ ...n, pitch: pitches[i] ?? n.pitch, startTime: times[i] ?? 0 }));
}

/** Remove consecutive duplicate pitches */
export function dedup(notes: Notes): Notes {
  return notes.filter((n, i) => i === 0 || n.pitch !== notes[i - 1]?.pitch);
}

/** Transpose all pitches by semitones */
export function add(notes: Notes, semitones: number): Notes {
  return notes.map(n => ({ ...n, pitch: clamp((n.pitch ?? 60) + Math.round(semitones), 0, 127) }));
}

/** Slow: stretch the pattern by factor (each note is factor times longer). */
export function slow(notes: Notes, factor: number): Notes {
  return notes.map(n => ({ ...n, startTime: n.startTime * factor, duration: n.duration * factor }));
}

/**
 * Fast: within each cycle, repeat that cycle's notes `factor` times (Tidal `fast`).
 *
 * Operates per-cycle against the structural `cycleBeats` grid — NOT the note extent —
 * so it lands exactly on the beat and matches the structural `[...]*N` repeat,
 * including how <> alternation has already resolved within each cycle.
 *   `X | fast N`  ≡  `[X]*N`
 */
export function fast(notes: Notes, factor: number, cycleBeats: number): Notes {
  const reps = Math.round(factor);
  if (reps <= 1 || notes.length === 0 || cycleBeats <= 0) return notes;
  const total = totalBeats(notes);
  const nCycles = Math.max(1, Math.ceil(total / cycleBeats - 1e-9));
  const sub = cycleBeats / reps;   // length of one repetition inside a cycle
  const result: NoteDescription[] = [];
  for (let c = 0; c < nCycles; c++) {
    const cycleStart = c * cycleBeats;
    const chunk = notes.filter(n => n.startTime >= cycleStart - 1e-9 && n.startTime < cycleStart + cycleBeats - 1e-9);
    for (let r = 0; r < reps; r++) {
      for (const n of chunk) {
        const local = n.startTime - cycleStart;            // 0 .. cycleBeats
        const st = cycleStart + r * sub + local / reps;    // compress into the r-th sub-window
        result.push({
          ...n,
          startTime: Math.round(st * 1e6) / 1e6,
          duration:  Math.round((n.duration / reps) * 1e6) / 1e6,
        });
      }
    }
  }
  return result.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
}

/**
 * Ratchet: retrigger each note `count` times within its own footprint (rapid-fire).
 * ratchet(4) on a note → 4 evenly-spaced hits, each filling its 1/count sub-slot
 * exactly. Length is left to the gate (default fill); use `| gate` for staccato
 * hits. "rand" picks 2–5 per note.
 */
export function ratchet(notes: Notes, count: number | "rand"): Notes {
  return notes.flatMap(n => {
    const c = count === "rand" ? 2 + Math.floor(Math.random() * 4) : Math.round(count);
    if (c <= 1) return [n];
    const d = n.duration / c;
    return Array.from({ length: c }, (_, i) => ({
      ...n,
      startTime: Math.round((n.startTime + i * d) * 1e6) / 1e6,
      duration:  Math.round(d * 1e6) / 1e6,
    }));
  });
}

/** Keep first N notes */
export function take(notes: Notes, n: number): Notes {
  return notes.slice(0, n);
}

/** Remove every Nth note (1-indexed) */
export function skip(notes: Notes, n: number): Notes {
  return notes.filter((_, i) => (i + 1) % n !== 0);
}

/** Set all velocities (or randomize) */
export function vel(notes: Notes, value: number | "rand"): Notes {
  return notes.map(n => ({
    ...n,
    velocity: value === "rand" ? Math.floor(40 + Math.random() * 87) : clamp(value, 1, 127),
  }));
}

/** Apply op every N cycles — splits notes into cycle chunks, applies to every Nth chunk */
export function every(
  notes: Notes,
  n: number,
  cycleBeats: number,
  applyOp: (ns: Notes) => Notes,
): Notes {
  const result: Notes[] = [];
  let cycle = 0;
  let cursor = 0;
  while (cursor < notes.length) {
    const cycleEnd = (cycle + 1) * cycleBeats;
    const chunk = notes.filter(note => note.startTime >= cycle * cycleBeats && note.startTime < cycleEnd);
    if ((cycle + 1) % n === 0) {
      const local = chunk.map(note => ({ ...note, startTime: note.startTime - cycle * cycleBeats }));
      const transformed = applyOp(local).map(note => ({ ...note, startTime: note.startTime + cycle * cycleBeats }));
      result.push(transformed);
    } else {
      result.push(chunk);
    }
    cursor += chunk.length;
    cycle++;
    if (cursor >= notes.length) break;
  }
  return result.flat();
}

/** Stack two note arrays (merge by time) */
export function merge(a: Notes, b: Notes): Notes {
  return [...a, ...b].sort((x, y) => x.startTime - y.startTime);
}

/** Euclidean rhythm: e(pulses, steps) — generates a rhythm pattern of given note/rest structure */
export function euclid(pulses: number, steps: number, beatDuration: number, pitch: number, velocity: number): Notes {
  const pattern = bjorklund(pulses, steps);
  const stepDur = beatDuration / steps;
  const notes: Notes = [];
  let t = 0;
  for (const hit of pattern) {
    if (hit) {
      notes.push({ pitch, startTime: t, duration: stepDur * 0.9, velocity });
    }
    t += stepDur;
  }
  return notes;
}

/** Bjorklund / Euclidean rhythm algorithm */
function bjorklund(pulses: number, steps: number): boolean[] {
  if (pulses >= steps) return Array(steps).fill(true);
  if (pulses === 0)    return Array(steps).fill(false);
  let pattern: boolean[][] = [
    ...Array(pulses).fill(null).map(() => [true]),
    ...Array(steps - pulses).fill(null).map(() => [false]),
  ];
  let remainder = steps - pulses;
  while (remainder > 1) {
    const groups = Math.min(pulses, remainder);
    const newPattern: boolean[][] = [];
    for (let i = 0; i < groups; i++) {
      newPattern.push([...(pattern[i] ?? []), ...(pattern[pattern.length - 1 - i] ?? [])]);
    }
    if (pulses > remainder) {
      for (let i = remainder; i < pulses; i++) newPattern.push(pattern[i] ?? []);
    } else {
      for (let i = pulses; i < pattern.length - groups; i++) newPattern.push(pattern[i] ?? []);
    }
    pulses = Math.min(pulses, remainder);
    remainder = Math.abs(pattern.length - groups * 2);
    pattern = newPattern;
  }
  return pattern.flat();
}

export function totalBeats(notes: Notes): number {
  return Math.max(0, ...notes.map(n => n.startTime + n.duration));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
