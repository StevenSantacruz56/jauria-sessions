import { Terminal } from '@xterm/xterm';
import { checkVector } from './program-status-parity';
import vectors from './program-status-vectors.json';

/** Runs every stream vector against the installed xterm in this browser. */
(window as unknown as { parity: () => Promise<Record<string, string[]>> }).parity = async () => {
  const result: Record<string, string[]> = {};
  for (const vector of vectors.streams) {
    const problems = await checkVector(() => new Terminal({ allowProposedApi: true }) as never, vector as never, 64);
    if (problems.length) result[vector.name] = problems;
  }
  return result;
};
(window as unknown as { parityReady: boolean }).parityReady = true;
