<script lang="ts">
	import ControlParams from './ControlParams.svelte';
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
		busy: boolean;
		onapplied: (r: { doc: Score; revisionId: string; diff: unknown }) => void;
		onstaged: (r: {
			doc: Score;
			revisionId: string;
			diff: { added: string[]; removed: string[]; changed: string[] };
			label: string;
		}) => void;
	}
	let { scoreId, controls, selection, busy, onapplied, onstaged }: Props = $props();

	let openId = $state<string | null>(null);
	let params = $state<Record<string, Record<string, unknown>>>({});
	let runningId = $state<string | null>(null);
	let error = $state('');
	let status = $state('');
	let source: EventSource | null = null;

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
		error = '';
		status = c.free ? '' : `${c.name}…`;

		try {
			const res = await fetch(`/api/scores/${scoreId}/controls/${c.id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ params: valuesFor(c), selection })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const result = await res.json();

			if (result.kind === 'applied') {
				onapplied(result);
				runningId = null;
				status = '';
				openId = null;
			} else {
				listen(result.jobId, c.name);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			runningId = null;
			status = '';
		}
	}

	function listen(jobId: string, label: string) {
		close();
		source = new EventSource(`/api/jobs/${jobId}/events`);

		source.addEventListener('iteration', (e) => {
			status = `${label} — step ${JSON.parse(e.data).n}`;
		});
		source.addEventListener('result', (e) => {
			const d = JSON.parse(e.data);
			if (d.warnings?.length) error = d.warnings.join(' ');
			if (d.doc && d.revisionId) {
				onstaged({ doc: d.doc, revisionId: d.revisionId, diff: d.diff, label });
				openId = null;
			} else {
				status = d.summary || 'No changes were made.';
			}
		});
		source.addEventListener('error', (e) => {
			const data = (e as MessageEvent).data;
			if (!data) return;
			try {
				error = JSON.parse(data).error ?? 'The control failed.';
			} catch {
				error = 'The control failed.';
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
		runningId = null;
		status = '';
	}

	function close() {
		source?.close();
		source = null;
	}

	$effect(() => () => close());
</script>

<p class="hint">
	Free controls apply instantly and cost nothing. Prompt and agent controls call the model and land
	as a change you review.
</p>

{#if error}
	<p class="msg err">{error}</p>
{:else if status}
	<p class="msg">{status}</p>
{/if}

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
						<span class="cname">{control.name}</span>
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
	.msg {
		margin: 0 0 var(--space-2);
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.err {
		color: var(--danger);
	}
</style>
