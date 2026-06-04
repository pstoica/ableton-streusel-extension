import { parse } from './src/parser.js';
const tests = [
  '0 2 4 | add 7',
  '0 2 4 | fast 2',
  '0 2 4 | slow 2 | rev',
  '0 2 4 | add=7',   // old style still works
  '0 2 4 | vel rand',
  '0 2 4 | take 3 | fast 2',
];
for (const t of tests) {
  const r = parse(t);
  console.log(`"${t}" → ops: ${r?.ops.map((o:any) => o.op + (o.value !== undefined ? '='+o.value : '')).join(', ')}`);
}
