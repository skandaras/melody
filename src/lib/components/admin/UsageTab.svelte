<script lang="ts">
	/**
	 * Admin → Usage.
	 *
	 * The budget line shows exactly what enforcement acts on — the same
	 * budgetStatus() the turn-start check reads — so what this panel says and
	 * what the cap does cannot drift apart. Enforcement is per turn: the model
	 * reports cost after a call completes, so one in-flight turn can overshoot
	 * before the next one is refused.
	 */

	interface Report {
		budget: {
			limitUsd: number;
			period: 'day' | 'week' | 'month';
			periodStart: string | Date;
			spentUsd: number;
			enforced: boolean;
		};
		daily: { day: string; costUsd: number; calls: number }[];
		models: { modelKey: string; costUsd: number; calls: number; tokens: number }[];
		tasks: { task: string; costUsd: number; calls: number }[];
		summary: { total: number; ok: number; error: number; avgDurationMs: number | null };
		events: {
			id: string;
			ts: number;
			task: string | null;
			type: string;
			name: string;
			status: string;
			durationMs: number | null;
		}[];
	}

	interface Props {
		initial: Report;
	}
	let { initial }: Props = $props();

	// The admin page re-mounts this tab with fresh data on every visit, so
	// seeding from the prop once is the intended behaviour, not a bug.
	// svelte-ignore state_referenced_locally
	let report = $state<Report>(initial);
	// svelte-ignore state_referenced_locally
	let limitText = $state(String(initial.budget.limitUsd || 0));
	// svelte-ignore state_referenced_locally
	let period = $state(initial.budget.period);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	const pct = $derived.by(() => {
		const { limitUsd, spentUsd } = report.budget;
		return limitUsd > 0 ? Math.min(100, (spentUsd / limitUsd) * 100) : 0;
	});

	const usd = (n: number) => (n >= 0 ? `$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
	const since = $derived(new Date(report.budget.periodStart).toLocaleDateString());

	async function saveBudget() {
		busy = true;
		error = '';
		notice = '';
		try {
			const res = await fetch('/api/admin/settings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ budget: { limitUsd: Number(limitText), period } })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			await refresh();
			notice = report.budget.enforced
				? `Budget saved — new AI turns are refused once period spend passes ${usd(report.budget.limitUsd)}.`
				: 'Budget saved — the cap is off while the limit is 0.';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function refresh() {
		const res = await fetch('/api/admin/usage');
		if (res.ok) report = await res.json();
	}

	const fmtDur = (ms: number | null) => (ms == null ? '' : ` · ${(ms / 1000).toFixed(1)}s`);
</script>

<p class="hint">
	The cap is checked when a turn starts, so it bounds runaway spend rather than predicting it. A
	limit of 0 disables the cap.
</p>

{#if error}<p class="msg err">{error}</p>{/if}
{#if notice}<p class="msg ok">{notice}</p>{/if}

<div class="budget">
	<div class="line">
		<strong>{usd(report.budget.spentUsd)}</strong> spent since {since}
		{#if report.budget.enforced}
			of {usd(report.budget.limitUsd)} per {report.budget.period} ({Math.round(pct)}%)
		{:else}
			— no cap set
		{/if}
	</div>
	{#if report.budget.enforced}
		<progress max="100" value={pct} aria-label="Budget used"></progress>
	{/if}
	<div class="row">
		<label>
			<span>Limit, $ per</span>
			<input type="number" min="0" step="0.5" bind:value={limitText} aria-label="Budget limit in US dollars" />
		</label>
		<select bind:value={period} aria-label="Budget period">
			<option value="day">day</option>
			<option value="week">week</option>
			<option value="month">month</option>
		</select>
		<button class="btn primary" onclick={saveBudget} disabled={busy}>
			{busy ? 'Saving…' : 'Save budget'}
		</button>
	</div>
</div>

<div class="cols">
	<section class="col">
		<h3>Model calls, 30 days</h3>
		{#if report.models.length}
			<table>
				<thead><tr><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
				<tbody>
					{#each report.models as m (m.modelKey)}
						<tr>
							<td><code>{m.modelKey}</code></td>
							<td>{m.calls}</td>
							<td>{m.tokens.toLocaleString()}</td>
							<td>{usd(m.costUsd)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="hint">No model calls recorded yet.</p>
		{/if}

		<h3>By task</h3>
		{#if report.tasks.length}
			<table>
				<thead><tr><th>Task</th><th>Calls</th><th>Cost</th></tr></thead>
				<tbody>
					{#each report.tasks as t (t.task)}
						<tr><td>{t.task}</td><td>{t.calls}</td><td>{usd(t.costUsd)}</td></tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="hint">Nothing per-task yet.</p>
		{/if}
	</section>

	<section class="col">
		<h3>Daily spend, 14 days</h3>
		{#if report.daily.length}
			<table>
				<tbody>
					{#each report.daily as d (d.day)}
						<tr><td>{d.day}</td><td>{d.calls} calls</td><td>{usd(d.costUsd)}</td></tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="hint">No spend recorded yet.</p>
		{/if}

		<h3>Activity, 30 days</h3>
		<p class="hint">
			{report.summary.total} finished · {report.summary.ok} ok · {report.summary.error} failed
			{#if report.summary.avgDurationMs != null}
				· averaging {(report.summary.avgDurationMs / 1000).toFixed(1)}s
			{/if}
		</p>
		<ul class="feed">
			{#each report.events as e (e.id)}
				<li>
					<span class="what">{e.name}</span>
					<span class="meta" class:err={e.status === 'error'}>
						{e.status}{fmtDur(e.durationMs)} · {new Date(e.ts).toLocaleString()}
					</span>
				</li>
			{/each}
		</ul>
		{#if !report.events.length}<p class="hint">No activity recorded yet.</p>{/if}
	</section>
</div>

<style>
	.budget {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		margin-bottom: var(--space-4);
	}
	.line {
		font-size: var(--text-sm);
		margin-bottom: var(--space-2);
	}
	progress {
		width: 100%;
		height: 6px;
		accent-color: var(--accent);
		margin-bottom: var(--space-2);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	label {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	input,
	select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
	}
	input[type='number'] {
		width: 7em;
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-4);
	}
	@media (max-width: 900px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.col h3 {
		font-size: var(--text-xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--fg-dim);
		margin: var(--space-3) 0 var(--space-2);
	}
	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 20rem;
		overflow-y: auto;
		font-size: var(--text-xs);
	}
	.feed li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.what {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		color: var(--fg-dim);
		flex: none;
	}
	.err {
		color: var(--danger);
	}
</style>
