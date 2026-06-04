import { evaluate } from './src/evaluator.js';
import { parse } from './src/parser.js';

const key = { rootNote: 0, scaleIntervals: [0,2,4,5,7,9,11], bpm: 120 };
const store = { get: () => undefined };

const p = parse('[0 1 2 3] | every=2:fast 4 @8');
const notes = evaluate(p!, key, store);
console.log(`total notes: ${notes.length}`);
for (let c = 0; c < 8; c++) {
  const cn = notes.filter(n => n.startTime >= c*4 && n.startTime < (c+1)*4);
  console.log(`  cycle ${c}: ${cn.length} notes at beats ${cn.map(n=>n.startTime.toFixed(2)).join(' ')}`);
}
