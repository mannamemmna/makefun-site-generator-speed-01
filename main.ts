// Entry driver: reads every case from /input/cases.json (MAKEFUN_INPUT_DIR), answers each with solve.js's run(),
// writes /output/answers.json (MAKEFUN_OUTPUT_DIR). Output must be byte-identical to makefun-site 1.0.0's.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 tuning allowed by the rules same as the house baseline. Default: keep incremental marking ON
// (the house turns it off; we verify locally which wins and flip here before submitting).
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));

if (process.env.BENCH_REPORT) {
  const u = process.cpuUsage();
  process.stdout.write(String((u.user + u.system) / 1000) + '\n');
}
