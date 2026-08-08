import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Vitest runs suites in parallel workers. Without a per-worker DATA_DIR they
 * all open the same SQLite file, and one suite's migration runs while
 * another's transaction is open. That is timing-dependent, so it passes
 * locally and fails in CI — the worst kind of flake to chase.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'melody-test-'));
process.env.AUTH_MODE = 'dev';
