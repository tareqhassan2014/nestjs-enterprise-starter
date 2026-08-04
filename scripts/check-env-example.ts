/**
 * Fails when `.env.example` and the environment schema drift apart, so a new
 * required variable cannot land without being documented for people forking
 * this repo.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { envSchema } from '../src/config/env.schema';

const EXAMPLE_PATH = resolve(process.cwd(), '.env.example');
const ASSIGNMENT = /^\s*([A-Z][A-Z0-9_]*)\s*=/;

function documentedVariables(): Set<string> {
  const contents = readFileSync(EXAMPLE_PATH, 'utf8');
  const names = new Set<string>();

  for (const line of contents.split('\n')) {
    const match = ASSIGNMENT.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }

  return names;
}

function main(): void {
  const declared = new Set(Object.keys(envSchema.shape));
  const documented = documentedVariables();

  const missing = [...declared].filter((name) => !documented.has(name)).sort();
  const extra = [...documented].filter((name) => !declared.has(name)).sort();

  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `.env.example is in sync with the schema (${declared.size} variables).`,
    );
    return;
  }

  console.error('.env.example is out of sync with src/config/env.schema.ts\n');

  if (missing.length > 0) {
    console.error('  Declared in the schema but missing from .env.example:');
    for (const name of missing) {
      console.error(`    - ${name}`);
    }
  }

  if (extra.length > 0) {
    console.error('  Present in .env.example but not declared in the schema:');
    for (const name of extra) {
      console.error(`    - ${name}`);
    }
  }

  process.exit(1);
}

main();
