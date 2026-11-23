// Entry driver: reads every case from /input/cases.json (MAKEFUN_INPUT_DIR), answers each with solve.js's run(),
// writes /output/answers.json (MAKEFUN_OUTPUT_DIR). Challenge: output trees byte-identical to makefun-site 1.0.0's.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 tuning: incremental marking kept ON is usually a win for batch churn like this, but the rules
// say the house baseline runs with it off and is timed with it; an entry may tune flags the same way.
// We evaluate both locally on this machine and keep whatever measures faster net of noise.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
