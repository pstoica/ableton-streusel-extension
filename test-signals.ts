import { evaluate } from './src/evaluator.js';
import { parse } from './src/parser.js';

const key = { rootNote: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], bpm: 120 };
const store = { get: () => undefined };
const run = (s: string) => evaluate(parse(s)!, key, store).sort((a, b) => a.startTime - b.startTime);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + detail}`);
};

// Velocity is normalized 0–1 → MIDI
check('vel 0.5 → 64', run('0*4 | vel 0.5').every(n => n.velocity === 64));
check('vel 1 → 127', run('0*4 | vel 1').every(n => n.velocity === 127));
check('vel 0 → 1 (no note-off)', run('0*4 | vel 0').every(n => n.velocity === 1));
check('vel [0.2 0.8] fractional pattern',
  JSON.stringify(run('0*2 | vel [0.2 0.8]').slice(0, 2).map(n => n.velocity)) === JSON.stringify([25, 102]));

// Waveform-driven velocity stays in 1..127
const sineV = run('0*16 | vel sine').map(n => n.velocity!);
check('vel sine within 1..127', sineV.every(v => v >= 1 && v <= 127));
check('vel sine actually varies', new Set(sineV).size > 4);

// square duty cycle: skew 0.25 over 8 steps → 2 high per bar
const sq = run('0*8 | vel square 1 skew 0.25').slice(0, 8).map(n => n.velocity);
check('square skew 0.25 → 2/8 high', sq.filter(v => v === 127).length === 2, JSON.stringify(sq));

// Pluck-to-scale: add <wave> snaps a continuous signal into the key
const scalePitches = new Set([0, 2, 4, 5, 7, 9, 11].flatMap(i => [60 + i, 72 + i, 48 + i]));
const plucked = run('0*16 | add sine(0,7)').map(n => n.pitch!);
check('add sine(0,7) stays in key', plucked.every(p => scalePitches.has(p)), JSON.stringify([...new Set(plucked)]));

// Waveform phase is continuous across bars (bar 2 sample == bar 1 at rate 1)
const tri = run('0*8 | vel tri').map(n => n.velocity);
check('rate-1 wave repeats per bar', JSON.stringify(tri.slice(0, 8)) === JSON.stringify(tri.slice(8, 16)));

console.log(`\n${pass}/${pass + fail} signal checks pass`);
if (fail) process.exit(1);
