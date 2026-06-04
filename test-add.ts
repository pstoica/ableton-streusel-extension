import { evaluate } from './src/evaluator.js';
import { parse } from './src/parser.js';

// C major: 0=C4, 1=D4, 2=E4, 3=F4, 4=G4, 5=A4, 6=B4, 7=C5...
const key = { rootNote: 0, scaleIntervals: [0,2,4,5,7,9,11], bpm: 120 };
const store = { get: () => undefined };

const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const midiName = (m: number) => noteNames[m%12] + Math.floor(m/12-1);

console.log('-- add (scale degrees, stays in key) --');
['0 2 4 | add 1', '0 2 4 | add 7', '0 2 4 | add 2'].forEach(t => {
  const p = parse(t)!;
  const notes = evaluate(p, key, store);
  console.log(`${t}: ${notes.map(n=>midiName(n.pitch!)).join(' ')}`);
});

console.log('\n-- semitones (chromatic) --');
['0 2 4 | semitones 7', '0 2 4 | semitones 12'].forEach(t => {
  const p = parse(t)!;
  const notes = evaluate(p, key, store);
  console.log(`${t}: ${notes.map(n=>midiName(n.pitch!)).join(' ')}`);
});
