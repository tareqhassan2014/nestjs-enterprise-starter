import { betterAuth } from 'better-auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer } from 'better-auth/plugins/bearer';
import { twoFactor } from 'better-auth/plugins/two-factor';

/**
 * Guards the CommonJS → ESM bridge, not any application behaviour.
 *
 * `better-auth` is ESM-only: `"type": "module"`, `.mjs` output, and no
 * `require` condition anywhere in its exports map. This project compiles to
 * CommonJS. Two separate mechanisms have to hold for that to work, and each
 * fails in a way that is cheap to catch here and expensive to diagnose later:
 *
 * 1. At runtime, Node's `require(esm)` loads the package. Unflagged only from
 *    Node 22.12, hence the `engines.node` floor. It also throws on a graph
 *    containing top-level `await` — that these imports resolve is the evidence
 *    this graph has none.
 * 2. Under Jest, the module registry intercepts the require and never reaches
 *    Node's `require(esm)`, so `NODE_OPTIONS=--experimental-vm-modules` is
 *    required. Without it this file fails at import with
 *    `SyntaxError: Cannot use import statement outside a module`.
 *
 * If this spec starts failing, the cause is almost certainly a dropped flag or
 * a Node downgrade — not the auth code. See design.md decision 1.
 */
describe('better-auth ESM interop', () => {
  it('exposes every entry point the auth module imports', () => {
    expect(typeof betterAuth).toBe('function');
    expect(typeof toNodeHandler).toBe('function');
    expect(typeof fromNodeHeaders).toBe('function');
    expect(typeof prismaAdapter).toBe('function');
    expect(typeof bearer).toBe('function');
    expect(typeof twoFactor).toBe('function');
  });
});
