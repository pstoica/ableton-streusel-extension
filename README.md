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
vel 80               set all velocities to 80
vel rand             randomize velocities
gate 0.5             note length as a fraction of its slot (alias: len)
ratchet 3            retrigger every note N rapid times
every 2:rev          apply an operation every N cycles
```

### Pattern arguments

`add`, `semitones`, `slow`, `fast`, `vel`, `gate`, and `ratchet` accept a **pattern**
instead of a single number. The pattern is sampled per note by its position in the
cycle, and `<>` advances per cycle:

```
0 2 4 | add <0 7>           alternate transpose each cycle
0 2 4 7 | vel [80 50 90 40] per-step velocities
0 5 | ratchet <1 3>         no ratchet on cycle 0, triple on cycle 1
```

`vel`, `gate`, and `ratchet` also accept `rand`.

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
| MIDI track | **Evaluate all on track** — evaluates all pattern clips on the track |
| Clip slot selection (Cmd+click) | **Evaluate selection** |
| Arrangement time selection | **Evaluate selection** |

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

## License

MIT
