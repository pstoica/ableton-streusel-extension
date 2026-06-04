import { parse } from './src/parser.js';
import { evaluate } from './src/evaluator.js';

const key = { rootNote: 0, scaleIntervals: [0,2,4,5,7,9,11], bpm: 120 };
const store = { get: () => undefined };

const tests = [
  ['<c3 e3> @4', 'simple alt 2 choices'],
  ['<c3 e3 g3> @3', 'alt 3 choices'],
  ['<0 5> @4', 'degree alt'],
  ['0 <2 4> 5 @4', 'alt in sequence'],
];

for (const [t, label] of tests) {
  const p = parse(t);
  if (!p) { console.log(`${label}: PARSE FAIL`); continue; }
  const notes = evaluate(p, key, store);
  console.log(`${label}: ${notes.length} notes → pitches per cycle:`);
  for (let c = 0; c < p.cycles; c++) {
    const cn = notes.filter(n => n.startTime >= c*4 && n.startTime < (c+1)*4);
    console.log(`  cycle ${c}: ${cn.map(n=>n.pitch).join(' ')}`);
  }
}
