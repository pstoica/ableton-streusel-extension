import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initialize,
  MidiClip,
  MidiTrack,
  ClipSlot,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";
import { parse } from "./parser.js";
import { evaluate, type ProjectKey, type ClipStore } from "./evaluator.js";
import { buildGraph, topoSort, dependents } from "./resolver.js";
import { generatePatterns, isAuthError, isModelError, DEFAULT_MODELS, MODEL_SUGGESTIONS, type LlmConfig, type Provider } from "./llm.js";

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

// ─── LLM config (persisted in the extension's storage directory) ──────────────
type Ctx = ReturnType<typeof initialize>;
const CONFIG_FILE = "streusel-config.json";

/** Persistent dir for config; falls back to ~/.streusel if the host gives us none. */
function storageDir(context: Ctx): string {
  return context.environment.storageDirectory || path.join(os.homedir(), ".streusel");
}
function configPath(context: Ctx): string {
  return path.join(storageDir(context), CONFIG_FILE);
}
function loadConfig(context: Ctx): LlmConfig | null {
  const p = configPath(context);
  try {
    if (!fs.existsSync(p)) return null;
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (c?.apiKey && c?.provider && c?.model) return c as LlmConfig;
  } catch (e) { console.error("[streusel] config read failed:", (e as Error).message); }
  return null;
}
function saveConfig(context: Ctx, cfg: LlmConfig): void {
  const p = configPath(context);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}
function clearConfig(context: Ctx): void {
  const p = configPath(context);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.error("[streusel] clear config failed:", (e as Error).message); }
}

/**
 * Write `html` to a temp file and return a file:// URL. Modal dialogs run page JS
 * reliably from file: URLs; data: URLs may block inline scripts so the Save button
 * never posts back.
 */
function dialogUrl(context: Ctx, html: string, name: string): string {
  const dir = context.environment.tempDirectory || storageDir(context);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, html, "utf8");
  return "file://" + p;
}

const POST_JS = `function post(s){var m={method:"close_and_send",params:[s]};` +
  `if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);` +
  `else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);}`;

/** Show a simple message modal (errors / notices). Best-effort. */
async function notify(context: Ctx, title: string, body: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:13px -apple-system,system-ui,sans-serif;background:#2b2b2b;color:#e6e6e6;margin:18px}
    h3{margin:0 0 8px} p{color:#bbb;white-space:pre-wrap;line-height:1.4}
    button{margin-top:14px;padding:7px 16px;background:#0a84ff;color:#fff;border:0;border-radius:4px;cursor:pointer}
  </style></head><body>
    <h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>
    <button id="ok">OK</button>
    <script>${POST_JS}document.getElementById('ok').addEventListener('click',function(){post("")});</script>
  </body></html>`;
  try { await context.ui.showModalDialog(dialogUrl(context, html, "streusel-message.html"), 440, 220); }
  catch (e) { console.error("[streusel] notify failed:", (e as Error).message); }
}

/** fetch from the host's Node, falling back to a node:https shim if global fetch is absent. */
const httpFetch: typeof fetch = (typeof fetch === "function")
  ? fetch
  : (((url: string, init: any = {}) => new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        { method: init.method || "GET", hostname: u.hostname, path: u.pathname + u.search, headers: init.headers },
        res => {
          let data = "";
          res.on("data", d => (data += d));
          res.on("end", () => resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(data),
            text: async () => data,
          } as Response));
        },
      );
      req.on("error", reject);
      if (init.body) req.write(init.body);
      req.end();
    })) as unknown as typeof fetch);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));

/** Settings form rendered into a modal; posts back the chosen { provider, model, apiKey }. */
function settingsHtml(current?: LlmConfig): string {
  const provider = current?.provider ?? "anthropic";
  const model = current?.model ?? "";
  const key = current?.apiKey ?? "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:13px -apple-system,system-ui,sans-serif;background:#2b2b2b;color:#e6e6e6;margin:16px}
    h3{margin:0 0 4px} .hint{color:#8a8a8a;font-size:11px;margin:4px 0 10px}
    label{display:block;margin:10px 0 4px}
    input,select{width:100%;box-sizing:border-box;padding:7px;background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:4px}
    button{margin-top:16px;padding:8px 16px;background:#0a84ff;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:13px}
  </style></head><body>
    <h3>Streusel — AI settings</h3>
    <div class="hint">Bring your own key. Stored locally; only sent to the provider you pick.</div>
    <label>Provider</label>
    <select id="provider">
      <option value="anthropic"${provider === "anthropic" ? " selected" : ""}>Anthropic (Claude)</option>
      <option value="openai"${provider === "openai" ? " selected" : ""}>OpenAI</option>
    </select>
    <label>Model</label>
    <input id="model" list="models" value="${escapeHtml(model)}" placeholder="model id">
    <datalist id="models"></datalist>
    <div class="hint">Use a model your account can access. If it's wrong you'll get to fix it.</div>
    <label>API key</label>
    <input id="key" type="password" value="${escapeHtml(key)}" placeholder="sk-...">
    <button id="save">Save</button>
    <script>
      ${POST_JS}
      var DEF=${JSON.stringify(DEFAULT_MODELS)};
      var SUG=${JSON.stringify(MODEL_SUGGESTIONS)};
      var pv=document.getElementById('provider'), md=document.getElementById('model'), dl=document.getElementById('models');
      function fillSug(){ dl.innerHTML=""; (SUG[pv.value]||[]).forEach(function(m){var o=document.createElement('option');o.value=m;dl.appendChild(o);}); }
      if(!md.value) md.value=DEF[pv.value];
      fillSug();
      pv.addEventListener('change',function(){ md.value=DEF[pv.value]; fillSug(); });
      document.getElementById('save').addEventListener('click',function(){
        post(JSON.stringify({provider:pv.value, model:(md.value||DEF[pv.value]).trim(), apiKey:document.getElementById('key').value.trim()}));
      });
    </script>
  </body></html>`;
}

/** Open the settings modal; persist and return the config, or null if cancelled. */
async function openSettings(context: Ctx, current?: LlmConfig): Promise<LlmConfig | null> {
  const url = dialogUrl(context, settingsHtml(current), "streusel-settings.html");
  let result: string;
  try {
    result = await context.ui.showModalDialog(url, 460, 360);
  } catch (e) {
    console.error("[streusel] settings dialog error:", (e as Error).message);
    return null;
  }
  console.log(`[streusel] settings dialog returned: ${result ? `${result.length} chars` : "(empty)"}`);
  if (!result) return null;
  let cfg: Partial<LlmConfig>;
  try {
    cfg = JSON.parse(result) as Partial<LlmConfig>;
  } catch (e) {
    console.error("[streusel] could not parse dialog result:", (e as Error).message, "raw:", result);
    return null;
  }
  if (!cfg.apiKey || !cfg.provider) { console.warn("[streusel] settings: missing key/provider"); return null; }
  const full: LlmConfig = {
    provider: cfg.provider as Provider,
    model: cfg.model || DEFAULT_MODELS[cfg.provider as Provider],
    apiKey: cfg.apiKey,
  };
  // Persist, but don't let a write failure block this session's generation.
  try { saveConfig(context, full); console.log(`[streusel] saved config → ${configPath(context)}`); }
  catch (e) { console.error("[streusel] could not save config:", (e as Error).message); }
  return full;
}

/** Locate the session-view slot holding a clip (to place variations beside it). */
function findClipSlot(context: Ctx, clip: MidiClip<"1.0.0">): { track: MidiTrack<"1.0.0">; index: number } | null {
  const targetName = clip.name.trim();
  for (const track of context.application.song.tracks) {
    if (!(track instanceof MidiTrack)) continue;
    const slots = track.clipSlots;
    for (let i = 0; i < slots.length; i++) {
      const c = slots[i]?.clip;
      if (c instanceof MidiClip && c.name.trim() === targetName) return { track: track as MidiTrack<"1.0.0">, index: i };
    }
  }
  return null;
}

/** Write a pattern's name + evaluated notes into a clip. */
function writePattern(clip: MidiClip<"1.0.0">, pattern: string, key: ProjectKey): boolean {
  const parsed = parse(pattern);
  if (!parsed) return false;
  const notes = evaluate(parsed, key, { get: () => undefined });
  clip.name = pattern;
  clip.notes = notes;
  clip.looping = true;
  return true;
}

/** Run one generation pass inside a progress dialog. Returns patterns or the error. */
async function runGeneration(
  context: Ctx, cfg: LlmConfig, description: string, count: number, key: ProjectKey,
): Promise<{ patterns?: string[]; error?: Error }> {
  try {
    let patterns: string[] = [];
    await context.ui.withinProgressDialog(`Generating ${count} pattern${count > 1 ? "s" : ""}…`, { progress: 0 }, async (update) => {
      await update(`Asking ${cfg.provider}…`, 25);
      patterns = await generatePatterns(cfg, description, count, key, httpFetch);
      await update("Writing clips…", 85);
    });
    return { patterns };
  } catch (e) {
    return { error: e as Error };
  }
}

/** Generate from a "?[N] description" clip name; write variation 1 into the clip, the rest into adjacent empty slots. */
async function generateForClip(context: Ctx, clip: MidiClip<"1.0.0">) {
  const raw = clip.name.trim();
  const m = raw.match(/^\?(\d*)\s*([\s\S]*)$/);
  if (!m || !m[2]?.trim()) {
    console.warn('[streusel] generate: name a clip like "? warm 8-note arp" (optionally "?4 ..." for variations)');
    return;
  }
  const count = m[1] ? Math.max(1, Math.min(16, parseInt(m[1], 10))) : 1;
  const description = m[2].trim();

  let cfg = loadConfig(context);
  if (!cfg) {
    cfg = await openSettings(context);
    if (!cfg) { console.warn("[streusel] generate: no API key set"); return; }
  }

  const key = getKey(context);
  let { patterns, error } = await runGeneration(context, cfg, description, count, key);

  // On a settings problem (bad key or unknown model): let the user fix it and retry once.
  if (error && (isAuthError(error.message) || isModelError(error.message))) {
    const auth = isAuthError(error.message);
    if (auth) clearConfig(context); // wipe a bad key; a bad model keeps the (valid) key
    console.warn(`[streusel] ${auth ? "auth" : "model"} error — re-prompting:`, error.message);
    await notify(
      context,
      auth ? "Invalid API key" : "Model not found",
      `${cfg.provider} error:\n${error.message}\n\n${auth ? "Enter a new API key." : "Pick a model your account can access."}`,
    );
    const fresh = await openSettings(context, auth ? { ...cfg, apiKey: "" } : cfg);
    if (!fresh) return;
    ({ patterns, error } = await runGeneration(context, fresh, description, count, key));
  }

  if (error) {
    console.error("[streusel] generate failed:", error.message);
    await notify(context, "Generation failed", error.message);
    return;
  }
  if (!patterns || !patterns.length) {
    console.warn("[streusel] generate: model returned no valid patterns");
    await notify(context, "No patterns", "The model didn't return any valid Streusel patterns. Try rephrasing the description.");
    return;
  }
  const pats = patterns;

  const loc = findClipSlot(context, clip);
  await context.withinTransaction(async () => {
    writePattern(clip, pats[0]!, key);
    if (loc && pats.length > 1) {
      const slots = loc.track.clipSlots;
      let vi = 1;
      for (let i = loc.index + 1; i < slots.length && vi < pats.length; i++) {
        if (slots[i]?.clip) continue; // occupied — skip to the next empty slot
        const parsed = parse(pats[vi]!);
        const length = (parsed?.cycles ?? 2) * 4;
        const newClip = (await slots[i]!.createMidiClip(length)) as MidiClip<"1.0.0">;
        writePattern(newClip, pats[vi]!, key);
        vi++;
      }
    }
  });
  console.log(`[streusel] generated ${pats.length} pattern(s) from "${description}"`);
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

  // Generate a pattern (or variations) from a "?[N] description" clip name
  context.commands.registerCommand("streusel.generate", async (arg: unknown) => {
    const clip = context.getObjectFromHandle(arg as Handle, MidiClip) as MidiClip<"1.0.0">;
    await generateForClip(context, clip);
  });

  // Open the AI settings dialog (provider / model / API key)
  context.commands.registerCommand("streusel.settings", async () => {
    await openSettings(context, loadConfig(context) ?? undefined);
  });

  // Context menus — selection commands first so they appear at top
  context.ui.registerContextMenuAction("ClipSlotSelection",              "Evaluate selection",        "streusel.evalSelection");
  context.ui.registerContextMenuAction("MidiTrack.ArrangementSelection", "Evaluate selection",        "streusel.evalArrangement");
  context.ui.registerContextMenuAction("MidiClip",                       "Evaluate + propagate",      "streusel.eval");
  context.ui.registerContextMenuAction("MidiClip",                       "Generate pattern (AI)",     "streusel.generate");
  context.ui.registerContextMenuAction("MidiClip",                       "Streusel: AI settings / key…", "streusel.settings");
  context.ui.registerContextMenuAction("MidiTrack",                      "Evaluate all on track",     "streusel.evalTrack");
  context.ui.registerContextMenuAction("MidiTrack",                      "Streusel: AI settings / key…", "streusel.settings");

  // ─── HTTP trigger server ────────────────────────────────────────────────────
  // Clips prefixed with * are "marked" — the hotkey evaluates all of them.
  // Name a clip "* 0 2 4 | rev @4" and it will be picked up by the hotkey.
  // The * is stripped before parsing so the rest is treated as a normal pattern.
  const MARKED_PREFIX = "* ";
  const HTTP_PORT = 7890;

  async function evalMarked() {
    const key = getKey(context);
    const allClips = getAllMidiClips(context);

    // Find all marked clips (prefix "* "), strip prefix for parsing
    const markedClips = allClips.filter(c => c.name.startsWith(MARKED_PREFIX));
    if (!markedClips.length) {
      console.log("[streusel] no marked clips (prefix them with '* ')");
      return;
    }

    // Build graph treating the stripped name as the pattern
    const store = new Map<string, NoteDescription[]>();
    for (const clip of allClips) {
      if (!parse(clip.name)) store.set(clip.name.trim(), [...clip.notes]);
    }

    let count = 0;
    await context.withinTransaction(async () => {
      for (const clip of markedClips) {
        const stripped = clip.name.slice(MARKED_PREFIX.length).trim();
        const parsed = parse(stripped);
        if (!parsed) continue;
        const clipStore = { get: (n: string) => store.get(n) };
        try {
          const notes = evaluate(parsed, key, clipStore);
          clip.notes = notes;
          clip.looping = true;
          store.set(clip.name.trim(), notes);
          console.log(`[streusel] hotkey: "${clip.name}" → ${notes.length} notes`);
          count++;
        } catch (e) {
          console.error(`[streusel] hotkey error for "${clip.name}":`, (e as Error).message);
        }
      }
    });
    console.log(`[streusel] hotkey: evaluated ${count} marked clip(s)`);
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/eval" || req.url === "/") {
      evalMarked().catch(e => console.error("[streusel] HTTP eval error:", e));
      res.writeHead(200); res.end("ok");
    } else if (req.url === "/ping") {
      res.writeHead(200); res.end("streusel running");
    } else {
      res.writeHead(404); res.end("not found");
    }
  });

  server.listen(HTTP_PORT, "127.0.0.1", () => {
    console.log(`[streusel] HTTP trigger listening on http://127.0.0.1:${HTTP_PORT}/eval`);
    console.log(`[streusel] mark clips with prefix "* " to evaluate on hotkey`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE")
      console.warn(`[streusel] port ${HTTP_PORT} already in use — HTTP trigger disabled`);
  });
}
