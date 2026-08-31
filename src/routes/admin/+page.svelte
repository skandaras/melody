<script lang="ts">
	import { untrack } from 'svelte';
	import TaskConfig from '$lib/components/TaskConfig.svelte';
	import UsageTab from '$lib/components/admin/UsageTab.svelte';
	import ControlsTab from '$lib/components/admin/ControlsTab.svelte';
	import SkillsTab from '$lib/components/admin/SkillsTab.svelte';
	import type { CoreTask } from '$lib/ai/config';
	import type { PageServerData } from './$types';

	type TaskView = PageServerData['tasks'][number];
	interface PromptVersion {
		id: string;
		systemPrompt: string;
		author: string;
		createdAt: number;
	}

	/**
	 * Providers and models.
	 *
	 * This is what stands between a fresh install and a working one: without a
	 * key, the eleven free controls work and nothing else does.
	 */

	let { data }: { data: PageServerData } = $props();

	// Seeded from the load, then owned locally — every action here mutates
	// server state and patches the local copy, so re-deriving from `data` would
	// fight that. untrack() makes "initial value only" explicit, and the effect
	// below re-seeds if the load ever re-runs.
	let providers = $state(untrack(() => data.providers));
	let models = $state(untrack(() => data.models));
	let settings = $state(untrack(() => ({ ...data.settings })));
	let tasks = $state(untrack(() => data.tasks));
	let tab = $state<'ai' | 'usage' | 'controls' | 'skills'>('ai');
	let history = $state<{ task: CoreTask; versions: PromptVersion[] } | null>(null);

	$effect(() => {
		providers = data.providers;
		models = data.models;
		settings = { ...data.settings };
		tasks = data.tasks;
	});

	/** Only these can be chosen anywhere: a model with no tool support cannot
	 *  drive the ops registry, so offering it would only produce puzzling runs. */
	const enabledModels = $derived(models.filter((m) => m.enabled && m.supportsTools));

	let apiKey = $state('');
	let busy = $state('');
	let error = $state('');
	let notice = $state('');
	let query = $state('');
	let showAll = $state(false);

	const active = $derived(providers.find((p) => p.enabled && p.hasKey) ?? providers[0]);
	const configured = $derived(Boolean(active?.hasKey));

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return models
			.filter((m) => (showAll ? true : m.supportsTools))
			.filter((m) => !q || m.modelKey.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
			.slice(0, 200);
	});

	async function post(path: string, body: unknown, label: string) {
		busy = label;
		error = '';
		notice = '';
		try {
			const res = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			return await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			return null;
		} finally {
			busy = '';
		}
	}

	async function saveKey() {
		if (!apiKey.trim()) return;
		const r = await post(
			'/api/admin/providers',
			{ id: active?.id, apiKey: apiKey.trim(), name: 'OpenRouter', enabled: true },
			'key'
		);
		if (!r) return;
		apiKey = '';
		await refreshProviders();
		notice = 'Key saved.';
	}

	async function clearKey() {
		if (!active || !confirm('Remove the stored API key?')) return;
		await post('/api/admin/providers', { id: active.id, apiKey: null }, 'key');
		await refreshProviders();
	}

	async function refreshProviders() {
		const res = await fetch('/api/admin/providers');
		if (res.ok) providers = (await res.json()).providers;
	}

	async function sync() {
		if (!active) return;
		const r = await post('/api/admin/models', { action: 'sync', providerId: active.id }, 'sync');
		if (!r) return;
		notice = `${r.result.total} models — ${r.result.added} new, ${r.result.updated} updated.`;
		const res = await fetch(`/api/admin/models?providerId=${active.id}&all=1`);
		if (res.ok) models = (await res.json()).models;
		await refreshProviders();
	}

	async function toggle(id: string, enabled: boolean) {
		models = models.map((m) => (m.id === id ? { ...m, enabled } : m));
		await post('/api/admin/models', { action: 'toggle', id, enabled }, '');
	}

	async function saveSettings() {
		const r = await post('/api/admin/settings', { models: settings }, 'settings');
		if (r) {
			settings = { ...r.models };
			notice = 'Saved.';
		}
	}

	const price = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);

	async function saveTaskConfig(patch: Partial<TaskView> & { task: CoreTask }) {
		const res = await post('/api/admin/tasks', patch, 'task');
		if (res?.task) {
			tasks = tasks.map((t) => (t.task === res.task.task ? res.task : t));
			notice = `Saved ${res.task.task}.`;
		}
		busy = '';
	}

	async function showHistory(task: CoreTask) {
		busy = 'history';
		try {
			const res = await fetch(`/api/admin/tasks?versionsFor=${encodeURIComponent(task)}`);
			if (!res.ok) throw new Error(await res.text());
			history = { task, versions: (await res.json()).versions };
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = '';
		}
	}

	async function restore(task: CoreTask, versionId: string) {
		const res = await post('/api/admin/tasks', { task, action: 'restore', versionId }, 'restore');
		if (res?.task) {
			tasks = tasks.map((t) => (t.task === task ? res.task : t));
			history = null;
			notice = `Restored an earlier prompt for ${task}.`;
		}
		busy = '';
	}
</script>

<svelte:head><title>Admin · melody</title></svelte:head>

<div class="admin">
	<h1>Admin</h1>

	{#if error}<p class="msg err">{error}</p>{/if}
	{#if notice}<p class="msg ok">{notice}</p>{/if}

	<nav class="tabs" aria-label="Admin sections">
		<button class="tab" class:on={tab === 'ai'} onclick={() => (tab = 'ai')}>AI</button>
		<button class="tab" class:on={tab === 'usage'} onclick={() => (tab = 'usage')}>Usage</button>
		<button class="tab" class:on={tab === 'controls'} onclick={() => (tab = 'controls')}>Controls</button>
		<button class="tab" class:on={tab === 'skills'} onclick={() => (tab = 'skills')}>Skills</button>
	</nav>

	{#if tab === 'ai'}
	<section>
		<h2>OpenRouter</h2>
		<p class="hint">
			One key reaches every model OpenRouter serves. Without it the free controls still work —
			everything that calls a model does not.
		</p>

		<div class="row">
			<span class="state" class:on={configured}>
				{#if configured}
					Key stored ····{active?.keyHint}
				{:else}
					No key stored
				{/if}
			</span>
			{#if configured}
				<button class="btn" onclick={clearKey} disabled={busy !== ''}>Remove</button>
			{/if}
		</div>

		<div class="row">
			<input
				type="password"
				bind:value={apiKey}
				placeholder="sk-or-v1-…"
				autocomplete="off"
				aria-label="OpenRouter API key"
			/>
			<button class="btn primary" onclick={saveKey} disabled={!apiKey.trim() || busy !== ''}>
				{busy === 'key' ? 'Saving…' : configured ? 'Replace' : 'Save'}
			</button>
		</div>
		<p class="hint small">
			The key is encrypted at rest and never sent back to this page — only whether one exists and
			its last four characters.
		</p>
	</section>

	<section>
		<h2>Models</h2>
		<div class="row">
			<button class="btn" onclick={sync} disabled={!configured || busy !== ''}>
				{busy === 'sync' ? 'Syncing…' : 'Sync catalogue'}
			</button>
			<span class="hint">{active?.modelCount ?? 0} known</span>
		</div>

		{#if models.length}
			<div class="row">
				<input bind:value={query} placeholder="Filter…" aria-label="Filter models" />
				<label class="check">
					<input type="checkbox" bind:checked={showAll} />
					<span>Include models without tool support</span>
				</label>
			</div>

			<table>
				<thead>
					<tr>
						<th>On</th><th>Model</th><th>Context</th><th>In /M</th><th>Out /M</th>
					</tr>
				</thead>
				<tbody>
					{#each shown as model (model.id)}
						<tr class:dim={!model.supportsTools}>
							<td>
								<input
									type="checkbox"
									checked={model.enabled}
									onchange={(e) => toggle(model.id, e.currentTarget.checked)}
									aria-label="Enable {model.modelKey}"
								/>
							</td>
							<td>
								<code>{model.modelKey}</code>
								{#if !model.supportsTools}<span class="tag">no tools</span>{/if}
							</td>
							<td>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : '—'}</td>
							<td>{price(model.promptCostPerMTok)}</td>
							<td>{price(model.completionCostPerMTok)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="hint">Sync the catalogue to choose a model.</p>
		{/if}
	</section>

	<section>
		<h2>Defaults</h2>
		<p class="hint">
			Used by every task that has no model of its own. Fallbacks are tried in order when the primary
			is unavailable. Nothing is preselected — melody will not pick a vendor, or spend your credit,
			on your behalf.
		</p>

		{#if !enabledModels.length}
			<p class="hint warn">
				No tool-capable models are enabled yet. Sync the catalogue above and enable the ones you
				want; a model that cannot call tools cannot edit a score.
			</p>
		{/if}

		<label>
			<span>Primary model</span>
			<select bind:value={settings.primary}>
				<option value="">None selected</option>
				{#each enabledModels as m (m.modelKey)}
					<option value={m.modelKey}>{m.displayName || m.modelKey}</option>
				{/each}
			</select>
		</label>
		<label>
			<span>Fallbacks, comma separated</span>
			<input
				value={settings.fallbacks.join(', ')}
				placeholder="tried in order if the primary is unavailable"
				oninput={(e) =>
					(settings.fallbacks = e.currentTarget.value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean))}
			/>
		</label>
		<label>
			<span>Max tokens per call</span>
			<input type="number" bind:value={settings.maxTokens} min="1000" step="1000" />
		</label>
		<button class="btn primary" onclick={saveSettings} disabled={busy !== ''}>
			{busy === 'settings' ? 'Saving…' : 'Save defaults'}
		</button>
	</section>

	<section>
		<h2>Tasks</h2>
		<p class="hint">
			Each job can name its own model and reasoning level. Titling a piece and orchestrating one
			want very different things, and paying the same rate for both is how a self-hosted instance
			ends up with a surprising bill. Anything left on “use the default” follows the setting above.
		</p>

		<div class="tasks">
			{#each tasks as t (t.task)}
				<TaskConfig
					task={t}
					blurb={data.blurbs[t.task]}
					models={models}
					fallbackModel={settings.primary}
					busy={busy !== ''}
					onsave={saveTaskConfig}
					onhistory={showHistory}
				/>
			{/each}
		</div>
	</section>
	{:else if tab === 'usage'}
		<UsageTab initial={data.usage} />
	{:else if tab === 'controls'}
		<ControlsTab initial={data.controls} />
	{:else if tab === 'skills'}
		<SkillsTab initial={data.skills} />
	{/if}

	{#if history}
		<!-- Bound once so the callbacks below don't have to re-narrow a value
		     that a Close click can set to null between render and invocation. -->
		{@const h = history}
		<div
			class="sheet"
			role="dialog"
			aria-modal="true"
			aria-label="Prompt history"
			tabindex="-1"
			onkeydown={(e) => e.key === 'Escape' && (history = null)}
		>
			<div class="sheet-inner">
				<header class="sheet-head">
					<strong>{h.task} — prompt history</strong>
					<button class="btn" onclick={() => (history = null)}>Close</button>
				</header>
				{#if h.versions.length === 0}
					<p class="hint">No saved versions yet.</p>
				{:else}
					<ul class="versions">
						{#each h.versions as v (v.id)}
							<li>
								<div class="vmeta">
									<span>{new Date(v.createdAt).toLocaleString()}</span>
									<span class="by">{v.author}</span>
									<button
										class="btn"
										onclick={() => restore(h.task, v.id)}
										disabled={busy !== ''}
									>
										Restore
									</button>
								</div>
								<pre>{v.systemPrompt}</pre>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.tasks {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	/* The four admin sections share one page load; tabs keep each one scannable
	   without turning them into routes that would re-fetch on every switch. */
	.tabs {
		display: flex;
		gap: var(--space-1);
		border-bottom: 1px solid var(--border);
	}
	.tab {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--fg-dim);
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
		font-size: var(--text-sm);
		margin-bottom: -1px;
	}
	.tab.on {
		color: var(--fg);
		border-bottom-color: var(--accent);
		font-weight: 600;
	}
	.warn {
		color: var(--diff-change);
	}

	/* Prompt history. A sheet rather than a route: it is a glance at what
	   changed, not somewhere to navigate to and come back from. */
	.sheet {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, #000 62%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 20;
	}
	.sheet-inner {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-4);
		max-width: 48rem;
		width: 100%;
		max-height: 80vh;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.sheet-head {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.sheet-head strong {
		flex: 1;
		font-size: var(--text-sm);
	}
	.versions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.versions li {
		border-top: 1px solid var(--border);
		padding-top: var(--space-2);
	}
	.vmeta {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-bottom: var(--space-1);
	}
	.vmeta .by {
		flex: 1;
	}
	.versions pre {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--fg);
		background: var(--bg);
		border-radius: var(--radius);
		padding: var(--space-2);
		max-height: 14rem;
		overflow: auto;
	}

	.admin {
		max-width: 60rem;
		margin: 0 auto;
		padding: var(--space-6) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	h1 {
		font-size: var(--text-lg);
		font-weight: 600;
	}
	h2 {
		font-size: var(--text-xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--fg-dim);
		margin-bottom: var(--space-2);
	}
	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0;
		line-height: 1.5;
	}
	.small {
		font-size: 0.68rem;
	}
	.state {
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.state.on {
		color: var(--diff-add);
		font-variant-numeric: tabular-nums;
	}
	input[type='password'],
	input[type='number'],
	input:not([type]) {
		flex: 1;
		min-width: 12rem;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.check {
		flex-direction: row;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}
	.check input {
		flex: none;
		min-width: 0;
		accent-color: var(--accent);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
		font-size: var(--text-sm);
		border-radius: var(--radius);
		align-self: flex-start;
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
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-xs);
	}
	th {
		text-align: left;
		color: var(--fg-dim);
		font-weight: 400;
		border-bottom: 1px solid var(--border);
		padding: var(--space-1);
	}
	td {
		padding: var(--space-1);
		border-bottom: 1px solid var(--border);
		font-variant-numeric: tabular-nums;
	}
	tr.dim {
		opacity: 0.5;
	}
	code {
		font-size: 0.72rem;
	}
	.tag {
		font-size: 0.6rem;
		text-transform: uppercase;
		color: var(--fg-dim);
		margin-left: var(--space-1);
	}
	.msg {
		margin: 0;
		font-size: var(--text-sm);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--bg-pane);
	}
	.err {
		color: var(--danger);
		border-left: 3px solid var(--danger);
	}
	.ok {
		color: var(--diff-add);
		border-left: 3px solid var(--diff-add);
	}
</style>
