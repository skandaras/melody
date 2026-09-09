<script lang="ts">
	import ControlParams from './ControlParams.svelte';
	import RunProgress from './RunProgress.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { isTerminal } from '$lib/runs/run-state';
	import type { Score, Selection } from '$lib/score/types';

	/**
	 * The control rack.
	 *
	 * The three tiers are shown as three different things, because they are:
	 * a `code` control is instant and free and applies straight away, while the
	 * model-backed ones cost money and take seconds. Hiding that behind a
	 * uniform button would make the cheap ones feel expensive and the expensive
	 * ones feel free.
	 */

	interface ControlSummary {
		id: string;
		name: string;
		category: string;
		kind: 'code' | 'prompt' | 'agent';
		icon: string | null;
		description: string;
		paramsSchema: Record<string, unknown> | null;
		defaultParams: Record<string, unknown> | null;
		free: boolean;
	}

	interface Props {
		scoreId: string;
		controls: ControlSummary[];
		selection: Selection;
		/**
		 * What that selection means, in words, shown on every control.
		 *
		 * The epic asks for this by name: "Selection defaults to the whole score
		 * … so make it *stated* rather than defaulted. Show the scope on the
		 * button: 'Darken · selection' vs. 'Darken · whole piece'." On the button
		 * rather than beside the rack because the moment of risk is the click, and
		 * a note a few centimetres away is a note nobody reads.
		 *
		 * Optional: the editor has its own selection readout above the rack and
		 * would only be repeating itself.
		 */
		scopeLabel?: string;
		busy: boolean;
		onapplied: (r: { doc: Score; revisionId: string; diff: unknown }) => void;
		onstaged: (r: {
			doc: Score;
			revisionId: string;
			diff: { added: string[]; removed: string[]; changed: string[] };
			label: string;
		}) => void;
	}
	let { scoreId, controls, selection, scopeLabel, busy, onapplied, onstaged }: Props = $props();

	let openId = $state<string | null>(null);
	let params = $state<Record<string, Record<string, unknown>>>({});
	let runningId = $state<string | null>(null);

	// Both tiers share one Run. The model-backed ones stream into it; a `code`
	// control settles it in one step — see run() below.
	const activeRun = new Run();

	const byCategory = $derived.by(() => {
		const map = new Map<string, ControlSummary[]>();
		for (const c of controls) {
			const list = map.get(c.category) ?? [];
			list.push(c);
			map.set(c.category, list);
		}
		return [...map.entries()];
	});

	const valuesFor = (c: ControlSummary) => params[c.id] ?? c.defaultParams ?? {};
	const hasParams = (c: ControlSummary) =>
		Boolean(c.paramsSchema?.properties && Object.keys(c.paramsSchema.properties).length);

	function toggle(c: ControlSummary) {
		// A control with no parameters has nothing to open, so clicking it runs
		// it. One with parameters opens first — firing a paid call before the
		// user has set the amount would be a surprise.
		if (!hasParams(c)) {
			void run(c);
			return;
		}
		openId = openId === c.id ? null : c.id;
	}

	async function run(c: ControlSummary) {
		if (runningId || busy) return;
		runningId = c.id;
		activeRun.reset();

		try {
			const res = await fetch(`/api/scores/${scoreId}/controls/${c.id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ params: valuesFor(c), selection })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const result = await res.json();
			// Closed as soon as the request lands, for both tiers. The parameters
			// have already been sent, so leaving the form open suggests they can
			// still be changed — and the old code only closed it on success, so a
			// control that failed left its panel open indefinitely.
			openId = null;

			if (result.kind === 'applied') {
				onapplied(result);
				settle(result.diff);
			} else {
				activeRun.listen(result.jobId, (r) => {
					onstaged({ ...r, doc: r.doc as Score, label: c.name });
				});
			}
		} catch (e) {
			// Reported through the run rather than beside it, so a control that
			// failed before a job existed reads the same as one that failed inside
			// it. There is one place a control says what happened.
			activeRun.push({
				type: 'error',
				data: { error: e instanceof Error ? e.message : String(e) }
			});
		}
	}

	/**
	 * Finish a free control's run, which was over before it could report.
	 *
	 * A `code` control is deterministic and instant, so it returns the finished
	 * document with no job and no SSE. Until now that meant it bypassed the run
	 * entirely and cleared `runningId` by hand — the "two code paths for what
	 * looks to the user like one action" that stages/5-refinement.md predicted.
	 *
	 * It needs no new API: `isTerminal` is false for an idle run, so the reducer
	 * accepts a run that begins and ends in one breath. `AudioInput` already
	 * drives the same state by hand for transcription, which is a Web Worker
	 * rather than a stream.
	 *
	 * The `result` push is load-bearing. `outcomeMessage` reports "Nothing was
	 * changed." for a finished run unless something was applied, so counting what
	 * the diff actually touched is what makes a successful control stay silent —
	 * the notation changing is its own confirmation — while one that matched
	 * nothing finally says so. Today it says nothing either way.
	 */
	function settle(diff: { added: string[]; removed: string[]; changed: string[] }): void {
		const touched = diff.added.length + diff.removed.length + diff.changed.length;
		activeRun.push({ type: 'result', data: { opsApplied: touched } });
		// `no_effect` is the word the server uses for a run that changed nothing,
		// and this is that run. Saying it the same way here means one vocabulary
		// for one situation, however the work happened to be done.
		activeRun.push({ type: 'done', data: { status: touched ? 'done' : 'no_effect' } });
	}

	// A finished run stops blocking the rack, but its last message stays on
	// screen until the next control is fired — that message is the only thing
	// telling the user what happened. Keyed on the run being over rather than on
	// it having had a job id, so the free tier is released by the same line.
	$effect(() => {
		if (runningId && isTerminal(activeRun.state)) runningId = null;
	});

	$effect(() => () => activeRun.destroy());
</script>

<p class="hint">
	Free controls apply instantly and cost nothing. Prompt and agent controls call the model and land
	as a change you review.
</p>

<RunProgress
	state={activeRun.state}
	oncancel={activeRun.running ? () => activeRun.cancel() : undefined}
	idleLabel="Working…"
/>

{#each byCategory as [category, list] (category)}
	<section>
		<h3>{category}</h3>
		<ul class="controls">
			{#each list as control (control.id)}
				<li class:open={openId === control.id}>
					<button
						class="control"
						title={control.description}
						disabled={busy || runningId !== null}
						onclick={() => toggle(control)}
					>
						<span class="icon" aria-hidden="true">{control.icon ?? '·'}</span>
						<span class="cname">
							{control.name}{#if scopeLabel}<span class="scope"> · {scopeLabel}</span>{/if}
						</span>
						<span class="kind kind-{control.kind}">
							{runningId === control.id ? '…' : control.free ? 'free' : control.kind}
						</span>
					</button>

					{#if openId === control.id}
						<div class="expand">
							<p class="desc">{control.description}</p>
							<ControlParams
								schema={control.paramsSchema}
								values={valuesFor(control)}
								disabled={runningId !== null}
								onchange={(v) => (params = { ...params, [control.id]: v })}
							/>
							<button
								class="apply"
								disabled={busy || runningId !== null}
								onclick={() => run(control)}
							>
								{control.free ? 'Apply' : 'Run'}
							</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/each}

<style>
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0 0 var(--space-2);
		line-height: 1.45;
	}
	h3 {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-bottom: var(--space-1);
	}
	.controls {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.control {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		background: none;
		border: 1px solid transparent;
		color: var(--fg);
		padding: var(--space-1) var(--space-2);
		text-align: left;
		cursor: pointer;
		font-size: var(--text-sm);
	}
	.control:hover:not(:disabled) {
		background: var(--bg-raise);
		border-color: var(--border);
	}
	.control:disabled {
		opacity: 0.55;
		cursor: default;
	}
	li.open .control {
		background: var(--bg-raise);
		border-color: var(--border);
	}
	.expand {
		padding: var(--space-1) var(--space-2) var(--space-2);
		background: var(--bg-raise);
		border: 1px solid var(--border);
		border-top: none;
	}
	.desc {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		line-height: 1.45;
	}
	.apply {
		width: 100%;
		background: var(--accent);
		color: var(--bg);
		border: none;
		font-weight: 600;
		padding: var(--space-1) var(--space-2);
		cursor: pointer;
		font-size: var(--text-xs);
		border-radius: var(--radius);
		margin-top: var(--space-1);
	}
	.apply:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.icon {
		width: 1.2em;
		color: var(--accent);
		text-align: center;
	}
	.cname {
		flex: 1;
		/* A control name plus a part name — "Modal interchange · Violoncello" —
		   outgrows a 20rem rail, so let it wrap rather than shove the tier tag
		   off the end. Truncating would be worse: an unreadable scope is the
		   thing this label exists to prevent. */
		min-width: 0;
	}
	.kind {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--fg-dim);
	}
	/* Free controls are visually distinct because that is the single most
	   useful thing to know before clicking one. */
	.kind-code {
		color: var(--diff-add);
	}
	/* Quieter than the control's own name: it qualifies the verb rather than
	   competing with it, and it is the same on every row. */
	.scope {
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
</style>
