import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { version } from '../src/index.js';

describe('version', () => {
  // The user agent is built from the exported constant, and changesets only
  // bumps package.json. This is the one thing keeping the two honest.
  it('matches package.json', () => {
    expect(version).toBe(pkg.version);
  });
});
