// Token launch radar (token-radar-01): entry point.
//
// Reads the sealed DefiLlama snapshot, ranks every protocol that still
// records no token with the peer-multiple model in lib/model.ts, and writes
// the board, the dashboard's data file, a copy of dashboard/ and
// screenshots/, and finally dossier.json (built with the vendored
// make.fun library, so the gate's rebuild matches byte for byte).
//
// Run locally:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildBoard, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

function flagValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputPath = flagValue('input', '/input');
const snapshotFile = inputPath.endsWith('.json') ? inputPath : join(inputPath, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  process.stderr.write(`radar: no snapshot at ${snapshotFile} (pass --input <file|dir>)\n`);
  process.exit(2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
const { rows, details } = buildBoard(snapshot);
const issue = boardIssue(rows, snapshot);
if (issue !== null) {
  process.stderr.write(`radar: refusing to write an invalid board: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(snapshot, details));

/** Copy a directory tree into the output, in sorted order, skipping dot-names. */
function copyTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (statSync(src).isDirectory()) {
      count += copyTree(src, join(to, name));
    } else {
      copyFileSync(src, join(to, name));
      count += 1;
    }
  }
  return count;
}

const dashboardFiles = copyTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles < 3) {
  process.stderr.write(`radar: screenshots/ holds ${shotFiles} files; the gate needs 3 or 4 images\n`);
  process.exit(1);
}

// Written last, from the finished output directory, with the gate's own caps.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65_536 }));

process.stdout.write(
  `radar: ${snapshot.protocols.length} protocols read, ${rows.length} pre-token rows ranked, ` +
    `${dashboardFiles} dashboard files and ${shotFiles} screenshots copied\n`,
);
