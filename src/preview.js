import { readFile } from 'node:fs/promises';
import { planSync } from './planner.js';
const filename = process.argv[2];
if (!filename) {
  console.error('Uso: npm run preview -- archivo.json (local, remote y baseline opcional). Solo genera un plan; no sincroniza.');
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(await readFile(filename, 'utf8'));
    console.log(JSON.stringify(planSync(input.local, input.remote, input.baseline ?? null), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
