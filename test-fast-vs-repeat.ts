import { evaluate } from './src/evaluator.js';
import { parse } from './src/parser.js';

const key = { rootNote: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], bpm: 120 };
const store = { get: () => undefined };

// Each case: a base pattern X, a factor N, and the cycle count.
// Assert that `X | fast N` produces the SAME notes as `[X]*N`, regardless of nesting.
const cases: [string, number, number][] = [
  ['0 2 4 7',        2, 2],   // plain seq
  ['<0 5> <2 4>',    2, 2],   // alternation atoms (advance per cycle)
  ['0 2 4 7',        4, 1],   // factor 4
  ['[0 2] 4',        2, 2],   // nested subdivision
  ['0 e3 7',         3, 2],   // mixed note names + degrees
  ['c3 [e3 g3]',     2, 1],   // note names, nested
  ['<0 2 4>',        4, 3],   // 3-way alternation, fast 4
];

const fmt = (ns: { startTime: number; pitch?: number }[]) =>
  [...ns].sort((a, b) => a.startTime - b.startTime || (a.pitch ?? 0) - (b.pitch ?? 0))
    .map(n => `${n.startTime.toFixed(3)}:${n.pitch}`).join(' ');

let pass = 0, fail = 0;
for (const [x, n, cyc] of cases) {
  const fastP = parse(`${x} | fast ${n} @${cyc}`)!;
  const starP = parse(`[${x}]*${n} @${cyc}`)!;
  const a = fmt(evaluate(fastP, key, store));
  const b = fmt(evaluate(starP, key, store));
  const ok = a === b;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'}  "${x}" | fast ${n}  vs  [${x}]*${n}  @${cyc}`);
  if (!ok) {
    console.log(`     fast: ${a}`);
    console.log(`     star: ${b}`);
  }
}
console.log(`\n${pass}/${pass + fail} cases match`);
if (fail) process.exit(1);
