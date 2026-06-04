import { parse } from './src/parser.js';
import { evaluate } from './src/evaluator.js';

const key = { rootNote: 0, scaleIntervals: [0,2,4,5,7,9,11], bpm: 120 };
const store = { get: () => undefined };

const tests = [
  ['0 2 4 5 | add <0 7> @2',    'alternating transpose per cycle'],
  ['0 2 4 5 | add [0 7 5 3]',   'subdivided add across bar'],
  ['0 2 4 5 | vel <60 100>',    'alternating velocity'],
  ['0 2 4 5 | vel [80 50 90 40]','velocity pattern across bar'],
  ['0 2 4 | add 7',              'plain scalar still works'],
];

for (const [t, label] of tests) {
  const p = parse(t);
  if (!p) { console.log(`${label}: PARSE FAIL`); continue; }
  const notes = evaluate(p, key, store);
  console.log(`${label}:`);
  notes.forEach(n => console.log(`  beat ${n.startTime.toFixed(2)} pitch=${n.pitch} vel=${n.velocity}`));
}
