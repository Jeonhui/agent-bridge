import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Finds the repository root by walking up until the shared fixtures appear.
 *
 * Tests used to reach fixtures with a counted stack of `../`, which broke the moment the package
 * layout changed. Searching for a landmark survives moves.
 */
export function repoRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);

  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "scripts", "fixtures", "filesystem-mcp.mjs"))) return dir;
    dir = dirname(dir);
  }

  throw new Error(`could not locate the repository root from ${from}`);
}

export function fixture(name: string): string {
  return join(repoRoot(), "scripts", "fixtures", name);
}
