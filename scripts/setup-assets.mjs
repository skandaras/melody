#!/usr/bin/env node
/**
 * Copy runtime assets out of node_modules into static/.
 *
 * Three things the browser needs that npm ships but a bundler won't emit:
 *   - the SpessaSynth AudioWorklet processor, which must be a real URL because
 *     addModule() fetches it rather than importing it;
 *   - the basic-pitch TensorFlow model, ~900KB, shipped inside the package;
 *   - a General MIDI soundfont.
 *
 * The soundfont comes from an npm package rather than a download, which means
 * setup is zero-touch and reproducible — no fetching a 40MB binary from a
 * mirror that may 403, and nothing large in git history. @librescore/sf3 is a
 * devDependency, so `npm prune --omit=dev` drops all 58MB of it from the
 * runtime image while the one file we copied stays in the build output.
 *
 * Idempotent: skips anything already present unless --force is passed.
 */

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const log = (msg) => console.log(`[assets] ${msg}`);

async function copyIfMissing(from, to, label) {
	if (!existsSync(from)) {
		log(`SKIP ${label} — not found at ${from.replace(root + '/', '')}`);
		return false;
	}
	if (existsSync(to) && !force) {
		log(`ok   ${label} (already present)`);
		return true;
	}
	await mkdir(dirname(to), { recursive: true });
	await copyFile(from, to);
	const { size } = await stat(to);
	log(`copy ${label} (${(size / 1e6).toFixed(1)}MB)`);
	return true;
}

// ---------------------------------------------------------------- worklet

await copyIfMissing(
	join(root, 'node_modules/spessasynth_lib/dist/spessasynth_processor.min.js'),
	join(root, 'static/spessasynth_processor.min.js'),
	'SpessaSynth worklet'
);

// ------------------------------------------------------------ basic-pitch

const modelDir = join(root, 'node_modules/@spotify/basic-pitch/model');
if (existsSync(modelDir)) {
	for (const name of await readdir(modelDir)) {
		await copyIfMissing(
			join(modelDir, name),
			join(root, 'static/basic-pitch-model', name),
			`basic-pitch ${name}`
		);
	}
} else {
	log('SKIP basic-pitch model — package not installed');
}

// ------------------------------------------------------------- soundfonts

/**
 * The package stores these with a .wasm extension so CDNs and bundlers treat
 * them as opaque binaries; they are ordinary SF3 (RIFF/sfbk) files, verified
 * by their header. We copy them back to .sf3.
 *
 * Two are shipped: the full-quality default, and a small one so a phone on a
 * slow connection has something usable. Which one is served is the
 * `audio.soundfontUrl` setting, so switching is a config change, not a
 * rebuild. FluidR3Mono_GM (14MB) is deliberately left out — it sits between
 * the two without being clearly better than either.
 */
const soundfonts = [
	['MuseScore_General_Lite.sf3.wasm', 'MuseScore_General.sf3', 'soundfont (full)'],
	['TimGM6mb.sf3.wasm', 'TimGM6mb.sf3', 'soundfont (compact)']
];

const sfDir = join(root, 'node_modules/@librescore/sf3');
if (existsSync(sfDir)) {
	for (const [from, to, label] of soundfonts) {
		await copyIfMissing(join(sfDir, from), join(root, 'static/soundfonts', to), label);
	}
	// Ship the licences beside the binaries — these are redistributable, but
	// only with their notices.
	for (const name of ['MuseScore_General_Lite.copyright', 'FluidR3Mono_License.md', 'TimGM6mb.copyright']) {
		await copyIfMissing(join(sfDir, name), join(root, 'static/soundfonts', name), `licence ${name}`);
	}
} else {
	log('SKIP soundfonts — @librescore/sf3 not installed (playback will be unavailable)');
}

log('done');
