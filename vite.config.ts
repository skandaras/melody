import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	worker: {
		// The transcription worker dynamically imports TensorFlow, so it has to
		// be code-split — and Vite's default IIFE worker format cannot be. ES
		// workers match the `{ type: 'module' }` the worker is constructed with,
		// and are supported everywhere WebAudio and MediaRecorder are.
		format: 'es'
	},
	test: {
		include: ['src/**/*.test.ts'],
		// Sets a per-worker DATA_DIR before any test module is imported, so parallel
		// suites don't collide on one SQLite file. See src/test-setup.ts.
		setupFiles: ['src/test-setup.ts']
	}
});
