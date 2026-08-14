<script lang="ts">
	import type { Score, Selection } from '$lib/score/types';

	/**
	 * Ask the model to change the score.
	 *
	 * The request returns a job id straight away and progress arrives over SSE,
	 * so a turn that takes half a minute survives a reload — the stream replays
	 * what was missed on reconnect.
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
	let running = $state(false);
	let error = $state('');
	let status = $state('');
	let log = $state<string[]>([]);
	let source: EventSource | null = null;

	const canSend = $derived(instruction.trim().length > 0 && !running && !busy);

	async function send() {
		if (!canSend) return;
		const text = instruction.trim();
		running = true;
		error = '';
		status = 'Starting…';
		log = [];

		try {
			const res = await fetch(`/api/scores/${scoreId}/ai`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ instruction: text, selection })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const { jobId } = await res.json();
			listen(jobId, text);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			running = false;
			status = '';
		}
	}

	function listen(jobId: string, label: string) {
		close();
		source = new EventSource(`/api/jobs/${jobId}/events`);

		source.addEventListener('status', (e) => {
			status = JSON.parse(e.data).message ?? '';
		});
		source.addEventListener('iteration', (e) => {
			status = `Working — step ${JSON.parse(e.data).n}`;
		});
		source.addEventListener('tool', (e) => {
			const d = JSON.parse(e.data);
			log = [...log, `${d.ok ? '·' : '✕'} ${d.detail ?? d.name}`].slice(-8);
		});
		source.addEventListener('result', (e) => {
			const d = JSON.parse(e.data);
			if (d.warnings?.length) error = d.warnings.join(' ');
			if (d.doc && d.revisionId) {
				onresult({ doc: d.doc, revisionId: d.revisionId, diff: d.diff, label });
				instruction = '';
			} else {
				status = d.summary || 'The model made no changes.';
			}
		});
		source.addEventListener('error', (e) => {
			// A payload means the job failed; no payload is the connection
			// dropping, which the browser retries on its own.
			const data = (e as MessageEvent).data;
			if (!data) return;
			try {
				error = JSON.parse(data).error ?? 'The request failed.';
			} catch {
				error = 'The request failed.';
			}
			stop();
		});
		source.addEventListener('done', () => stop());
		source.onerror = () => {
			if (source?.readyState === EventSource.CLOSED) stop();
		};
	}

	function stop() {
		close();
		running = false;
		status = '';
	}

	function close() {
		source?.close();
		source = null;
	}

	$effect(() => () => close());

	function onkeydown(e: KeyboardEvent) {
		// Enter sends; newlines need a modifier. The box is one instruction,
		// not a document.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}
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

	{#if status}
		<p class="msg">{status}</p>
	{/if}

	{#if log.length}
		<ul class="log">
			{#each log as line, i (i)}
				<li>{line}</li>
			{/each}
		</ul>
	{/if}

	{#if error}
		<p class="msg err">{error}</p>
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
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		font-variant-numeric: tabular-nums;
	}
	.log li {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
