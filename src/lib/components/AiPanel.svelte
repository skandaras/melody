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
	/** Prose as it arrives, so a long turn shows something other than a number. */
	let streamed = $state('');
	let step = $state(0);
	let log = $state<string[]>([]);
	let source: EventSource | null = null;
	/** Whether this turn reached a real outcome, as opposed to the stream dying. */
	let settled = false;

	const canSend = $derived(instruction.trim().length > 0 && !running && !busy);

	async function send() {
		if (!canSend) return;
		const text = instruction.trim();
		running = true;
		error = '';
		status = 'Starting…';
		log = [];
		// Cleared here rather than in stop(): the last thing a finished turn says
		// is the only thing the user has to read, and wiping it on `done` is what
		// made a model that answered without editing look like a hang.
		streamed = '';
		step = 0;
		settled = false;

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
			step = JSON.parse(e.data).n;
			// Each step starts its own prose, so drop the last one rather than
			// letting two iterations' sentences run together.
			streamed = '';
			status = `Working — step ${step}`;
		});
		source.addEventListener('reasoning', () => {
			// Reasoning is hidden by default, so this usually carries no text —
			// but knowing the model is thinking is the point.
			status = `Thinking — step ${step}`;
		});
		source.addEventListener('delta', (e) => {
			streamed += JSON.parse(e.data).text ?? '';
			status = '';
		});
		source.addEventListener('tool', (e) => {
			const d = JSON.parse(e.data);
			log = [...log, `${d.ok ? '·' : '✕'} ${d.detail ?? d.name}`].slice(-8);
		});
		source.addEventListener('result', (e) => {
			const d = JSON.parse(e.data);
			settled = true;
			if (d.warnings?.length) error = d.warnings.join(' ');
			if (d.doc && d.revisionId) {
				onresult({ doc: d.doc, revisionId: d.revisionId, diff: d.diff, label });
				instruction = '';
			} else if (d.outcome === 'cancelled') {
				status = 'Cancelled — nothing was changed.';
			} else if (d.opsRejected > 0) {
				// The distinction the server now draws: it tried and every edit
				// missed, which is a different problem from having nothing to say.
				status =
					d.summary ||
					`Tried ${d.opsRejected} edit${d.opsRejected === 1 ? '' : 's'}, but none of them matched anything in the score.`;
			} else {
				status = d.summary || 'The model made no changes.';
			}
			streamed = '';
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
			// The error is the message now; a leftover "Working — step 3" beside
			// it would only contradict it.
			settled = true;
			status = '';
			stop();
		});
		source.addEventListener('done', () => stop());
		source.onerror = () => {
			if (source?.readyState !== EventSource.CLOSED) return;
			// Closed without an outcome: the turn is still running server-side and
			// will finish, but this panel has stopped hearing about it. Saying so
			// is the whole point — a stale progress line reads as a hang.
			if (!settled) {
				status = '';
				error = 'Lost the connection to this turn. It may still be running — reload to pick it up.';
			}
			stop();
		};
	}

	function stop() {
		close();
		running = false;
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

	{#if streamed}
		<p class="msg streamed">{streamed}</p>
	{/if}
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
	.streamed {
		color: var(--fg);
		max-height: 8rem;
		overflow-y: auto;
		white-space: pre-wrap;
		border-left: 2px solid var(--border);
		padding-left: var(--space-2);
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
