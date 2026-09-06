<script lang="ts">
	import RunProgress from './RunProgress.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import type { Score, Selection } from '$lib/score/types';

	/**
	 * Ask the model to change the score.
	 *
	 * The request returns a job id straight away and progress arrives over SSE,
	 * so a turn that takes half a minute survives a reload — the stream replays
	 * what was missed on reconnect. Everything about watching that stream lives
	 * in `Run`; this component is the box you type into.
	 */

	interface Props {
		scoreId: string;
		selection: Selection;
		selectionCount: number;
		busy: boolean;
		/** Called with the staged result so the editor can show the diff. */
		onresult: (result: {
			doc: Score;
			revisionId: string;
			diff: { added: string[]; removed: string[]; changed: string[] };
			label: string;
		}) => void;
	}
	let { scoreId, selection, selectionCount, busy, onresult }: Props = $props();

	let instruction = $state('');
	/** Only for a request that failed before a job existed. The run owns the rest. */
	let startError = $state('');

	const run = new Run();
	const running = $derived(run.running);
	const canSend = $derived(instruction.trim().length > 0 && !running && !busy);

	async function send() {
		if (!canSend) return;
		const text = instruction.trim();
		startError = '';
		run.reset();

		try {
			const res = await fetch(`/api/scores/${scoreId}/ai`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ instruction: text, selection })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const { jobId } = await res.json();
			run.listen(jobId, (r) => {
				onresult({ ...r, doc: r.doc as Score, label: text });
				instruction = '';
			});
		} catch (e) {
			startError = e instanceof Error ? e.message : String(e);
		}
	}

	function onkeydown(e: KeyboardEvent) {
		// Enter sends; newlines need a modifier. The box is one instruction,
		// not a document.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}

	$effect(() => () => run.destroy());
</script>

<div class="ai">
	<textarea
		bind:value={instruction}
		{onkeydown}
		placeholder={selectionCount
			? `Change the ${selectionCount} selected notes…`
			: 'Describe a change to the whole piece…'}
		rows="3"
		disabled={running}
		aria-label="Instruction for the AI"
	></textarea>

	<div class="row">
		<span class="scope">
			{selectionCount ? `${selectionCount} selected` : 'whole piece'}
		</span>
		<div class="spacer"></div>
		<button class="btn primary" onclick={send} disabled={!canSend}>
			{running ? 'Working…' : 'Ask'}
		</button>
	</div>

	<RunProgress state={run.state} oncancel={() => run.cancel()} idleLabel="Thinking…" />

	{#if startError}
		<p class="msg err">{startError}</p>
	{/if}
</div>

<style>
	.ai {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	textarea {
		width: 100%;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		font: inherit;
		font-size: var(--text-sm);
		resize: vertical;
	}
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.spacer {
		flex: 1;
	}
	.scope {
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
		font-size: var(--text-sm);
		border-radius: var(--radius);
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.msg {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		line-height: 1.4;
	}
	.err {
		color: var(--danger);
	}
</style>
