# Streusel

A clip-name pattern language for Ableton Live, built with the [Ableton Extensions SDK](https://www.ableton.com/en/extensions/). Write patterns in clip names, right-click to evaluate. Clips can reference each other by name — change a source clip and all dependent clips rebuild automatically.

Inspired by [mutateful](https://github.com/carrierdown/mutateful), [TidalCycles](https://tidalcycles.org), and [Strudel](https://strudel.cc). The mini-notation syntax (`0 2 4`, `[Ref] | rev | add=7`) is loosely modelled on Tidal/Strudel's pattern language, but implemented entirely in TypeScript running natively in Node — no browser context, no webview, no CDN. Patterns evaluate in milliseconds.

## Clip name syntax

```
[n:] <expression> [| <operation>]* [@<cycles>]
```

Operators take their argument after `=` **or** a space — `add=7` and `add 7` are equivalent.

### Expressions

```
c3 e3 g3 a3          literal note sequence
0 2 4 -1             scale-degree sequence (uses Live's current key/scale)
.   ~                rest (either symbol)
[a b c]              subdivision — a, b, c share one step's time
<a b c>              alternation — cycle 0→a, 1→b, 2→c, then wraps
{a b c}%4            polyrhythm — play a, b, c spread over 4 even slots
e(3,8)               euclidean rhythm: 3 pulses over 8 steps
[Melody]             reference another clip by name
[A] + [B]            merge (stack) two clips
```

### Atom modifiers

Append directly to an atom or a closing bracket. They combine, and apply to whole
groups (`[0 2]^3`, `<0 5>*2`):

```
*N                   repeat N times inside the current step     0*4
!N  or  !            elongate — atom takes N slots (bare ! = 2)  0!2
^N  or  ^            ratchet — N rapid retriggers in the slot    c3^4
?                    optional — 50% chance of playing each pass  e3?
```

### Chromatic mode (`n:`)

Prefix a pattern with `n:` to make bare numbers **chromatic semitone offsets** from
the project root (`0` → MIDI 60), instead of scale degrees. Note names still work
alongside. Handy for breakbeat slicing / chromatic sampler triggering.

```
n: 0 1 2 3 6 8       → MIDI 60 61 62 63 66 68 (chromatic)
0 1 2 3 6 8          → scale degrees (stays in key)
```

### Operations (piped with `|`)

```
rev                  reverse note order
sort                 sort by pitch ascending
shuffle              randomize order
dedup                remove consecutive duplicate pitches
add 7                shift by 7 scale degrees (stays in key)
semitones 7          shift by 7 chromatic semitones
slow 2               halve speed (stretch durations)
fast 2               double speed — repeat to fill (see below)
take 4               keep first N notes
skip 2               remove every Nth note
vel 0.8              set velocity, normalized 0–1 (0.8 → 102)
vel rand             random velocity per note
gate 0.5             note length as a fraction of its slot (alias: len)
ratchet 3            retrigger every note N rapid times
every 2:rev          apply an operation every N cycles
```

### Velocity is normalized 0–1

`vel` takes a **0–1** value (`0` = soft, `1` = full), scaled to MIDI 1–127. So
`vel 0.5` → 64. Patterns and signals work too: `vel [0.2 0.8]`, `vel sine`.

> **Breaking change:** velocity is no longer raw 0–127. Old patterns like `vel 80`
> now clamp to full — change them to `vel 0.63`.

### Pattern arguments

`add`, `semitones`, `slow`, `fast`, `vel`, `gate`, and `ratchet` accept a **pattern**
instead of a single number. The pattern is sampled per note by its position in the
cycle, and `<>` advances per cycle. Pattern values may be fractional (handy for the
0–1 ops):

```
0 2 4 | add <0 7>            alternate transpose each cycle
0 2 4 7 | vel [0.6 0.4 0.9 0.3]   per-step velocities
0 5 | ratchet <1 3>         no ratchet on cycle 0, triple on cycle 1
```

`vel`, `gate`, and `ratchet` also accept `rand` (random per note, 0–1).

### Waveforms (continuous signals)

Where an op takes a number, you can instead give a **waveform** — a continuous LFO
sampled per note by its position in the clip. Shapes: `sine`, `saw`, `isaw`, `tri`,
`square`, `noise`. The phase runs continuously across the whole clip, so it stays
smooth from bar to bar.

```
<shape>[(lo,hi)] [rate] [phase P] [skew S]
```

| Part | Meaning | Default |
|---|---|---|
| `(lo,hi)` | output range | `0,1` |
| `rate` | cycles per bar | `1` |
| `phase P` | phase offset, 0–1 | `0` |
| `skew S` | pulse-width (square) / peak (tri) / ramp curve (saw), 0–1 | `0.5` |

```
0*16 | vel sine                 velocity swells up and down each bar
0*16 | gate saw 2               note length ramps, twice per bar
0*8  | vel square 1 skew 0.25   25% duty-cycle gate of velocity
c1*16 | vel noise(0.3,1)        humanized random velocity
```

**Pluck to scale.** Feed a waveform into `add` (scale-degree shift) and the continuous
signal is quantized into the current key — a melody plucked from the scale:

```
0*16 | add sine(0,7)            sine melody, snapped to the scale
0*16 | add saw(0,7) | vel tri   ascending run + triangle dynamics
c3*16 | semitones tri(-12,12)   chromatic triangle glide (off the scale)
```

> **No MIDI CC / automation:** the Extensions SDK can't write CC lanes or clip
> envelopes yet, so waveforms modulate **note properties** (velocity, gate, pitch),
> not control-change data.

### Note length / gate

By default every note **fills its slot exactly** — evenly spread, no gaps, no
overlap. Use `gate` (alias `len`) to shorten into staccato or lengthen into overlap:

```
0 2 4 7 | gate 0.5          staccato (half-length, gaps)
0 2 4 7 | gate 0.9          slight gap between notes
0 2 4 7 | gate 1.5          legato / overlapping tails
0 2 4 7 | gate rand         random length per note
```

### Ratcheting

`^N` on an atom, or `| ratchet N` as an operation, splits a note into N evenly-spaced
rapid hits within its slot (`rand` picks 2–5). Hits fill their sub-slot by default;
their length follows the gate, so chain `| gate` for staccato retriggers. It composes
with `<>` — the alternation resolves first, then the chosen note ratchets; or the
**count** itself can alternate:

```
c3^4                        four hits of c3 filling the step
c3^4 | gate 0.6             four retriggers with gaps between them
0 2 4 | ratchet 3           every note tripled
<0 5>^3                     ratchets whichever note the alt picks this cycle
0 5 | ratchet <1 3>         ratchet count alternates per cycle
```

### Fast vs. repeat

`X | fast N` is equivalent to `[X]*N` — both repeat the pattern N times **within each
cycle**, landing exactly on the grid and resolving `<>` alternation identically.

### Cycle count

Append `@N` to set how many cycles to render (default: 2):

```
0 2 4 5 @4           4 cycles
[Melody] | rev @8    8 cycles
```

### Examples

```
c3 e3 g3             C major triad arpeggiated over 2 cycles
0 2 4 5 7            degrees in the project key
e(3,8) @2            euclidean rhythm, 2 cycles
c3^4                 ratcheted note — 4 rapid hits
n: 0 3 7 10 | rev    chromatic slice indices, reversed
0 2 4 | add <0 7>    call-and-response transpose per cycle
[Melody] | rev       retrograde of "Melody" clip
[Melody] | semitones 7            "Melody" up a chromatic fifth
[A] + [B]            merge clips A and B
[Melody] | every 2:rev | fast 2   reversed every other cycle, at 2x speed
```

## Dependency graph

When you evaluate a clip, Streusel scans the entire session for clips that reference it and rebuilds them automatically in dependency order. Change `[Melody]`, right-click → **Evaluate + propagate** → all derived clips update.

## Commands

| Context | Command |
|---|---|
| MIDI clip | **Evaluate + propagate** — evaluates this clip + all that reference it |
| MIDI clip | **Generate pattern (AI)** — turn a `?`-prefixed description into a pattern |
| MIDI track | **Evaluate all on track** — evaluates all pattern clips on the track |
| MIDI track | **Streusel: AI settings…** — set provider / model / API key |
| Clip slot selection (Cmd+click) | **Evaluate selection** |
| Arrangement time selection | **Evaluate selection** |

## AI generation

Describe what you want in a clip name with a `?` prefix, then right-click →
**Generate pattern (AI)**. The model writes a Streusel pattern, the clip is
renamed to it, and the notes are evaluated. Generated patterns are validated —
anything that doesn't parse is discarded.

```
? warm 8-note arpeggio that rises             → one pattern, in the project key
?4 driving techno bassline                    → 4 variations
```

With `?N`, variation 1 replaces the clip and the rest fill the next empty slots
in the same track column — so you audition them by playing the slots.

**Bring your own key.** The first generate opens a dialog to pick a provider
(Anthropic or OpenAI), model, and paste your API key. It's stored locally in the
extension's storage directory and only sent to the provider you choose — nothing
is bundled or shared. Change or reset it anytime via **Streusel: AI settings / key…**
(on the clip or track menu).

If the provider rejects the key **or the model** (e.g. an unknown / retired model
ID), Streusel tells you why and re-opens the dialog so you can fix it — then retries
automatically. The model field suggests current IDs per provider, but use whatever
your account can access.

## Hotkey (marked clips)

Live can't bind extension commands to keys directly, so Streusel exposes a tiny local
HTTP trigger instead. Bind a global keyboard shortcut to hit it and re-evaluate every
**marked** clip at once — handy for live performance / quick iteration without leaving
the keyboard.

**1. Mark the clips you want the hotkey to rebuild** by prefixing their name with `* `
(asterisk + space). The prefix is stripped before parsing, so the rest is a normal
pattern:

```
* 0 2 4 | rev @4
* [Melody] | every 2:rev
```

**2. The extension serves the trigger on `http://127.0.0.1:7890`** (it logs the URL on
startup). Endpoints:

| URL | Action |
|---|---|
| `/eval` (or `/`) | Re-evaluate all marked clips, in dependency order |
| `/ping` | Health check — returns `streusel running` |

Verify it's up:

```bash
curl http://127.0.0.1:7890/ping     # → streusel running
curl http://127.0.0.1:7890/eval     # → ok  (rebuilds marked clips)
```

**3. Bind a key to `curl -s http://127.0.0.1:7890/eval`** using any global hotkey tool.
On macOS, for example:

- **Hammerspoon** — in `~/.hammerspoon/init.lua`:
  ```lua
  hs.hotkey.bind({"cmd", "alt"}, "E", function()
    hs.execute("curl -s http://127.0.0.1:7890/eval")
  end)
  ```
- **Keyboard Maestro / BetterTouchTool** — add a macro that runs the shell command
  `curl -s http://127.0.0.1:7890/eval`, triggered by your chosen key.
- **Shortcuts.app / Automator** — a "Run Shell Script" action with the same `curl`,
  assigned a keyboard shortcut.

The trigger only listens on `127.0.0.1`, so it's local-only. If port `7890` is taken,
the server logs a warning and the trigger is disabled (the right-click commands still
work).

## Installation

Requires:
- Ableton Live with Extensions support (beta)
- Node.js ≥ 24

```bash
git clone ...
cd streusel-extension
npm install
cp .env.example .env  # set EXTENSION_HOST_PATH
```

Enable **Developer Mode** in Live → Settings → Extensions, then:

```bash
npm start
```

## Tests

```bash
npm test          # typecheck + run the suite (test/run.ts)
npm run test:run  # suite only (no typecheck)
```

`test/run.ts` is a single deterministic assertion suite (~60 checks) covering
atoms, structure (`[]` `<>` `{}%` euclid), modifiers, the `n:` flag, every op,
velocity/gate/ratchet, waveforms, `fast ≡ [X]*N`, refs, and the dependency
resolver. It runs on every push via GitHub Actions — and because the suite only
imports the SDK as types, CI runs it with `npx tsx` without needing the SDK
installed.

## Building / packaging

```bash
npm run build        # bundle src → dist/extension.js (dev)
npm run build:prod   # minified production bundle
npm run package      # build:prod + zip into streusel-<version>.ablx
```

The `.ablx` is the installable Ableton extension archive. Packaging must run
locally (the SDK is a local-only dependency), so it can't build on CI. See
[RELEASING.md](RELEASING.md) for the release checklist.

## License

MIT
