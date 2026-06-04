import {
  initialize,
  MidiClip,
  MidiTrack,
  ClipSlot,
  Song,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";
import { parse } from "./parser.js";
import { evaluate, type ProjectKey, type ClipStore } from "./evaluator.js";
import { buildGraph, topoSort, dependents } from "./resolver.js";

// ─── Project key from Live ────────────────────────────────────────────────────
function getKey(context: ReturnType<typeof initialize>): ProjectKey {
  const song = context.application.song;
  return {
    rootNote: song.rootNote % 12,
    scaleIntervals: song.scaleIntervals,
    bpm: song.tempo,
  };
}

// ─── Collect all MIDI clips in session ────────────────────────────────────────
function getAllMidiClips(context: ReturnType<typeof initialize>): MidiClip<"1.0.0">[] {
  const clips: MidiClip<"1.0.0">[] = [];
  for (const track of context.application.song.tracks) {
    if (!(track instanceof MidiTrack)) continue;
    // Session clips
    for (const slot of track.clipSlots) {
      if (slot.clip instanceof MidiClip) clips.push(slot.clip as MidiClip<"1.0.0">);
    }
    // Arrangement clips
    for (const clip of track.arrangementClips) {
      if (clip instanceof MidiClip) clips.push(clip as MidiClip<"1.0.0">);
    }
  }
  return clips;
}

// ─── Evaluate one clip and write notes ───────────────────────────────────────
function evalClip(
  clip: MidiClip<"1.0.0">,
  key: ProjectKey,
  store: Map<string, NoteDescription[]>,
): NoteDescription[] | null {
  const parsed = parse(clip.name);
  if (!parsed) return null;

  const clipStore: ClipStore = { get: (name) => store.get(name) };
  try {
    return evaluate(parsed, key, clipStore);
  } catch (e) {
    console.error(`[streusel] eval error for "${clip.name}":`, (e as Error).message);
    return null;
  }
}

// ─── Core: evaluate a clip + all dependents in order ─────────────────────────
async function evalAndPropagate(
  context: ReturnType<typeof initialize>,
  sourceClip: MidiClip<"1.0.0">,
) {
  const key = getKey(context);
  const allClips = getAllMidiClips(context);
  const graph = buildGraph(allClips);
  const store = new Map<NoteDescription[], never>() as unknown as Map<string, NoteDescription[]>;

  // Seed store with notes from non-pattern clips (they're references, not derived)
  for (const clip of allClips) {
    if (!parse(clip.name)) {
      store.set(clip.name.trim(), [...clip.notes]);
    }
  }

  // Determine what to evaluate: source + dependents
  const sourceName = sourceClip.name.trim();
  const toEval = [sourceName, ...dependents(sourceName, graph)];
  const order = (() => {
    try { return topoSort(graph); } catch { return [...graph.keys()]; }
  })();
  const ordered = order.filter(n => toEval.includes(n));

  let count = 0;
  await context.withinTransaction(async () => {
    for (const name of ordered) {
      const node = graph.get(name);
      if (!node) continue;
      const notes = evalClip(node.clip, key, store);
      if (!notes) continue;
      node.clip.notes = notes;
      node.clip.looping = true;
      store.set(name, notes);
      count++;
      console.log(`[streusel] "${name}" → ${notes.length} notes`);
    }
  });
  console.log(`[streusel] evaluated ${count} clip(s)`);
}

// ─── Batch: evaluate all pattern clips on a track/selection ──────────────────
async function evalBatch(
  context: ReturnType<typeof initialize>,
  clips: MidiClip<"1.0.0">[],
) {
  const key = getKey(context);
  const allClips = getAllMidiClips(context);
  const graph = buildGraph(allClips);
  const store = new Map<string, NoteDescription[]>();

  for (const clip of allClips) {
    if (!parse(clip.name)) store.set(clip.name.trim(), [...clip.notes]);
  }

  const order = (() => {
    try { return topoSort(graph); } catch { return [...graph.keys()]; }
  })();
  const names = new Set(clips.map(c => c.name.trim()));
  const ordered = order.filter(n => names.has(n));

  let count = 0;
  await context.withinTransaction(async () => {
    for (const name of ordered) {
      const node = graph.get(name);
      if (!node) continue;
      const notes = evalClip(node.clip, key, store);
      if (!notes) continue;
      node.clip.notes = notes;
      node.clip.looping = true;
      store.set(name, notes);
      count++;
    }
  });
  console.log(`[streusel] batch: evaluated ${count} clip(s)`);
}

// ─── Extension entry ──────────────────────────────────────────────────────────
export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // Evaluate this clip + all clips that reference it (cascade)
  context.commands.registerCommand("streusel.eval", async (arg: unknown) => {
    const clip = context.getObjectFromHandle(arg as Handle, MidiClip);
    await evalAndPropagate(context, clip as MidiClip<"1.0.0">);
  });

  // Evaluate all pattern clips on a track
  context.commands.registerCommand("streusel.evalTrack", async (arg: unknown) => {
    const track = context.getObjectFromHandle(arg as Handle, MidiTrack);
    const clips = [
      ...track.clipSlots.flatMap(s => s.clip instanceof MidiClip ? [s.clip as MidiClip<"1.0.0">] : []),
      ...track.arrangementClips.filter((c): c is MidiClip<"1.0.0"> => c instanceof MidiClip),
    ];
    await evalBatch(context, clips);
  });

  // Session view multi-select
  context.commands.registerCommand("streusel.evalSelection", async (arg: unknown) => {
    const sel = arg as ClipSlotSelection;
    const clips: MidiClip<"1.0.0">[] = [];
    for (const h of sel.selected_clip_slots) {
      const slot = context.getObjectFromHandle(h, ClipSlot);
      if (slot.clip instanceof MidiClip) clips.push(slot.clip as MidiClip<"1.0.0">);
    }
    await evalBatch(context, clips);
  });

  // Arrangement view time-range selection
  context.commands.registerCommand("streusel.evalArrangement", async (arg: unknown) => {
    const sel = arg as ArrangementSelection;
    const clips: MidiClip<"1.0.0">[] = [];
    for (const h of sel.selected_lanes) {
      const track = context.getObjectFromHandle(h, MidiTrack);
      for (const c of track.arrangementClips) {
        if (!(c instanceof MidiClip)) continue;
        const s = c.startTime, e = s + c.duration;
        if (e > sel.time_selection_start && s < sel.time_selection_end)
          clips.push(c as MidiClip<"1.0.0">);
      }
    }
    await evalBatch(context, clips);
  });

  // Context menus — selection commands first so they appear at top
  context.ui.registerContextMenuAction("ClipSlotSelection",              "Evaluate selection",        "streusel.evalSelection");
  context.ui.registerContextMenuAction("MidiTrack.ArrangementSelection", "Evaluate selection",        "streusel.evalArrangement");
  context.ui.registerContextMenuAction("MidiClip",                       "Evaluate + propagate",      "streusel.eval");
  context.ui.registerContextMenuAction("MidiTrack",                      "Evaluate all on track",     "streusel.evalTrack");
}
