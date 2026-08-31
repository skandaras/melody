<script lang="ts">
	import { renderScoreToWav } from '$lib/audio/synth';
	import { downloadBlob, safeFilename } from '$lib/export/download';
	import { scoreToMidiBlob } from '$lib/export/midi';
	import type { Score } from '$lib/score/types';

	/**
	 * The four ways a score leaves the app.
	 *
	 * All of them run in the browser — MIDI and MusicXML are pure serialisation,
	 * WAV renders through an OfflineAudioContext, and the PDF is drawn from the
	 * same SVG the engraver already produced. The server does none of it, which
	 * is what keeps this affordable on a small box.
	 */

	interface Props {
		score: Score;
		soundfontUrl: string;
		/** Offline render rate, from Admin → Audio. */
		renderSampleRate: number;
	}
	let { score, soundfontUrl, renderSampleRate }: Props = $props();

	let working = $state('');
	let error = $state('');

	const empty = $derived(score.parts.every((p) => p.voices.every((v) => v.events.length === 0)));

	async function run(kind: string, fn: () => Promise<void> | void) {
		if (working) return;
		working = kind;
		error = '';
		try {
			await fn();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			working = '';
		}
	}

	const exportMidi = () =>
		run('midi', () => downloadBlob(scoreToMidiBlob(score), safeFilename(score.title, 'mid')));

	const exportXml = () =>
		run('xml', async () => {
			// Dynamic so the serialiser is not in the editor's initial bundle.
			const { scoreToMusicXmlBlob } = await import('$lib/export/musicxml');
			downloadBlob(scoreToMusicXmlBlob(score), safeFilename(score.title, 'musicxml'));
		});

	const exportPdf = () =>
		run('pdf', async () => {
			const { scoreToPdf } = await import('$lib/export/pdf');
			downloadBlob(await scoreToPdf(score), safeFilename(score.title, 'pdf'));
		});

	const exportWav = () =>
		run('wav', async () =>
			downloadBlob(
				await renderScoreToWav(score, soundfontUrl, { sampleRate: renderSampleRate }),
				safeFilename(score.title, 'wav')
			)
		);
</script>

<div class="export">
	<button class="btn" onclick={exportPdf} disabled={empty || working !== ''} title="Vector score">
		{working === 'pdf' ? '…' : 'PDF'}
	</button>
	<button
		class="btn"
		onclick={exportXml}
		disabled={empty || working !== ''}
		title="MusicXML — opens in MuseScore, Sibelius, Dorico"
	>
		{working === 'xml' ? '…' : 'XML'}
	</button>
	<button class="btn" onclick={exportMidi} disabled={empty || working !== ''} title="Standard MIDI file">
		{working === 'midi' ? '…' : 'MIDI'}
	</button>
	<button class="btn" onclick={exportWav} disabled={empty || working !== ''} title="Rendered audio">
		{working === 'wav' ? 'rendering…' : 'WAV'}
	</button>

	{#if error}<span class="err" title={error}>export failed</span>{/if}
</div>

<style>
	.export {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		cursor: pointer;
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-xs);
		border-radius: var(--radius);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.err {
		color: var(--danger);
		font-size: var(--text-xs);
		cursor: help;
	}
</style>
