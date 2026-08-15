<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageServerData } from './$types';

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

	$effect(() => {
		providers = data.providers;
		models = data.models;
		settings = { ...data.settings };
	});

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
</script>

<svelte:head><title>Admin · melody</title></svelte:head>

<div class="admin">
	<h1>Admin</h1>

	{#if error}<p class="msg err">{error}</p>{/if}
	{#if notice}<p class="msg ok">{notice}</p>{/if}

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
			is unavailable.
		</p>
		<label>
			<span>Primary model</span>
			<input bind:value={settings.primary} placeholder="anthropic/claude-opus-5" />
		</label>
		<label>
			<span>Fallbacks, comma separated</span>
			<input
				value={settings.fallbacks.join(', ')}
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
</div>

<style>
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
