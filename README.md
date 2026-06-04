# Streusel

A clip-name pattern language for Ableton Live, built with the [Ableton Extensions SDK](https://www.ableton.com/en/extensions/). Write patterns in clip names, right-click to evaluate. Clips can reference each other by name — change a source clip and all dependent clips rebuild automatically.

Inspired by [mutateful](https://github.com/carrierdown/mutateful), [TidalCycles](https://tidalcycles.org), and [Strudel](https://strudel.cc). The mini-notation syntax (`0 2 4`, `[Ref] | rev | add=7`) is loosely modelled on Tidal/Strudel's pattern language, but implemented entirely in TypeScript running natively in Node — no browser context, no webview, no CDN. Patterns evaluate in milliseconds.

## Clip name syntax

```
<expression> [| <operation>]* [@<cycles>]
```

### Expressions

```
c3 e3 g3 a3          literal note sequence
0 2 4 -1             scale-degree sequence (uses Live's current key/scale)
[Melody]             reference another clip by name
[A] + [B]            merge (stack) two clips
e(3,8)               euclidean rhythm: 3 pulses over 8 steps
```

### Operations (piped with `|`)

```
rev                  reverse note order
sort                 sort by pitch ascending
shuffle              randomize order
dedup                remove consecutive duplicate pitches
add=7                transpose by semitones
slow=2               halve speed (stretch durations)
fast=2               double speed
take=4               keep first N notes
skip=2               remove every Nth note
vel=80               set all velocities to 80
vel=rand             randomize velocities
every=2:rev          apply operation every N cycles
```

### Cycle count

Append `@N` to set how many cycles to render (default: 2):

```
0 2 4 5 @4           4 cycles
[Melody] | rev @8    8 cycles
```

### Examples

```
c3 e3 g3             C major triad arpeggiated over 2 cycles
0 2 4 5 7            pentatonic-ish degrees in project key
e(3,8) @2            euclidean rhythm, 2 cycles
[Melody] | rev       retrograde of "Melody" clip
[Melody] | add=7     "Melody" transposed up a fifth
[A] + [B]            merge clips A and B
[Melody] | every=2:rev | fast=2   reversed every other cycle, at 2x speed
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
