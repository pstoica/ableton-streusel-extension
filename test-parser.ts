import { parse } from './src/parser.js';
const tests: [string, string][] = [
  ['c3 [e3 g3] a3', 'subdivision'],
  ['<c3 e3> <g3 a3>', 'alternation'],
  ['c3? e3 g3?', 'optional'],
  ['c3*3 e3', 'repeat *'],
  ['c3!2 e3', 'elongate !'],
  ['{c3 e3 g3}%8', 'polyrhythm {}%N'],
  ['0 [2 4] <5 7> @4', 'mixed+cycles'],
  ['[Melody] | rev | add=7', 'ref+ops'],
  ['e(3,8)', 'euclidean'],
  ['c3 ~ e3 g3', 'with rest'],
  ['c3 e3 [g3 b3]*2', 'nested repeat'],
];
for (const [t, label] of tests) {
  try {
    const r = parse(t);
    if (!r) { console.log(`${label}: null`); continue; }
    const desc = r.items.map(w => {
      const a = w.atom;
      const b = a.kind==='seq'?`[${(a as any).items.length}]`:a.kind==='alt'?`<${(a as any).choices.length}>`:a.kind==='poly'?`{${(a as any).steps}}`:a.kind;
      return `${b}${w.repeat>1?`*${w.repeat}`:''}${w.weight>1?`!${w.weight}`:''}${w.optional?'?':''}`;
    }).join(' ');
    console.log(`✓ ${label}: ${desc} | ops=${r.ops.map((o:any)=>o.op).join(',')||'-'} cycles=${r.cycles} refs=${JSON.stringify(r.refs)}`);
  } catch(e) { console.log(`✗ ${label}: ${(e as Error).message}`); }
}
