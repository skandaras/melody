<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { LIGHT_PRESETS, PRESETS, themeCss, type Theme } from '$lib/theme';
	import type { PageServerData } from './$types';

	/**
	 * Appearance.
	 *
	 * Changes preview live by swapping the same token block the layout renders
	 * server-side, so what you see while dragging a slider is exactly what gets
	 * saved — no separate preview rendering to drift out of step with the real
	 * thing.
	 */

	let { data }: { data: PageServerData } = $props();

	let theme = $state<Theme>(untrack(() => ({ ...data.theme })));
	let saved = $state<Theme>(untrack(() => ({ ...data.theme })));
	let busy = $state(false);
	let error = $state('');

	const dirty = $derived(JSON.stringify(theme) !== JSON.stringify(saved));

	// Live preview: replace the layout's own token block rather than adding a
	// second one, so there is only ever one source of truth on the page.
	$effect(() => {
		const css = themeCss(theme);
		const el = document.getElementById('melody-theme');
		if (el) el.textContent = css;
	});

	// Restore the saved theme if the page is left with unsaved changes.
	$effect(() => () => {
		const el = document.getElementById('melody-theme');
		if (el) el.textContent = themeCss(saved);
	});

	const COLOURS: { key: keyof Theme; label: string; hint?: string }[] = [
		{ key: 'bg', label: 'Page' },
		{ key: 'bgPane', label: 'Panels' },
		{ key: 'bgRaise', label: 'Raised' },
		{ key: 'fg', label: 'Text' },
		{ key: 'fgDim', label: 'Dimmed text' },
		{ key: 'accent', label: 'Accent', hint: 'Links, primary buttons, selection' },
		{ key: 'border', label: 'Borders' },
		{ key: 'danger', label: 'Errors' },
		{ key: 'notation', label: 'Notation ink', hint: 'Staves, noteheads, stems' },
		{ key: 'notationPaper', label: 'Score paper', hint: 'Kept separate so a dark UI can show a light score' },
		{ key: 'diffAdd', label: 'Diff — added' },
		{ key: 'diffChange', label: 'Diff — changed' },
		{ key: 'diffRemove', label: 'Diff — removed' }
	];

	function usePreset(name: string) {
		theme = { ...PRESETS[name] };
	}

	async function save() {
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ theme })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const { theme: stored } = await res.json();
			// Read back what was stored rather than what was sent: the sanitiser
			// may have rejected a value, and the form should show the truth.
			theme = { ...stored };
			saved = { ...stored };
			await invalidateAll();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function revert() {
		theme = { ...saved };
	}
</script>

<svelte:head><title>Settings · melody</title></svelte:head>

<div class="settings">
	<header>
		<h1>Appearance</h1>
		{#if dirty}
			<div class="actions">
				<button class="btn" onclick={revert} disabled={busy}>Revert</button>
				<button class="btn primary" onclick={save} disabled={busy}>
					{busy ? 'Saving…' : 'Save'}
				</button>
			</div>
		{/if}
	</header>

	{#if error}<p class="msg err">{error}</p>{/if}

	<section>
		<h2>Presets</h2>
		<div class="presets">
			{#each Object.keys(PRESETS) as name (name)}
				<button class="preset" onclick={() => usePreset(name)}>
					<span
						class="swatch"
						style="background:{PRESETS[name].bg};border-color:{PRESETS[name].border}"
					>
						<span class="dot" style="background:{PRESETS[name].accent}"></span>
						<span class="bar" style="background:{PRESETS[name].fg}"></span>
					</span>
					<span class="pname">{name}</span>
					<span class="tone">{LIGHT_PRESETS.has(name) ? 'light' : 'dark'}</span>
				</button>
			{/each}
		</div>
	</section>

	<section>
		<h2>Scale</h2>
		<p class="hint">
			Notation size is independent of the interface — big notes with small chrome is a common
			preference, and so is the reverse.
		</p>

		<label>
			<span class="label">Base text size <em>{theme.baseFont}</em></span>
			<input
				type="range"
				min="75"
				max="150"
				step="5"
				value={Number.parseFloat(theme.baseFont) || 100}
				oninput={(e) => (theme = { ...theme, baseFont: `${e.currentTarget.value}%` })}
			/>
		</label>

		<label>
			<span class="label">Notation scale <em>{theme.notationScale.toFixed(2)}×</em></span>
			<input
				type="range"
				min="0.6"
				max="2"
				step="0.05"
				value={theme.notationScale}
				oninput={(e) => (theme = { ...theme, notationScale: Number(e.currentTarget.value) })}
			/>
		</label>

		<label>
			<span class="label">Density <em>{theme.spaceBase.toFixed(2)}rem</em></span>
			<input
				type="range"
				min="0.15"
				max="0.4"
				step="0.01"
				value={theme.spaceBase}
				oninput={(e) => (theme = { ...theme, spaceBase: Number(e.currentTarget.value) })}
			/>
		</label>

		<label>
			<span class="label">Corner radius <em>{theme.radius}</em></span>
			<input
				type="range"
				min="0"
				max="16"
				step="1"
				value={Number.parseFloat(theme.radius) || 0}
				oninput={(e) => (theme = { ...theme, radius: `${e.currentTarget.value}px` })}
			/>
		</label>
	</section>

	<section>
		<h2>Colours</h2>
		<div class="colours">
			{#each COLOURS as field (field.key)}
				<label class="colour" title={field.hint}>
					<input
						type="color"
						value={String(theme[field.key])}
						oninput={(e) => (theme = { ...theme, [field.key]: e.currentTarget.value })}
						aria-label={field.label}
					/>
					<span>
						{field.label}
						<code>{theme[field.key]}</code>
					</span>
				</label>
			{/each}
		</div>
	</section>

	<section>
		<h2>Preview</h2>
		<div class="preview">
			<div class="pane">
				<p class="pfg">The quick brown fox</p>
				<p class="pdim">Dimmed supporting text</p>
				<div class="prow">
					<button class="btn primary">Primary</button>
					<button class="btn">Secondary</button>
					<span class="pdanger">Error</span>
				</div>
				<div class="paper">
					<span class="ink">♩ ♪ ♫ — notation ink on score paper</span>
				</div>
				<div class="prow">
					<span class="chip add">added</span>
					<span class="chip change">changed</span>
					<span class="chip remove">removed</span>
				</div>
			</div>
		</div>
	</section>
</div>

<style>
	.settings {
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--space-6) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	h1 {
		font-size: var(--text-lg);
		font-weight: 600;
		flex: 1;
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
	.actions {
		display: flex;
		gap: var(--space-2);
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0;
		line-height: 1.5;
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

	.presets {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.preset {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		cursor: pointer;
		color: var(--fg);
		font-size: var(--text-xs);
	}
	.preset:hover {
		border-color: var(--accent);
	}
	.swatch {
		width: 3.5rem;
		height: 2.2rem;
		border: 1px solid;
		border-radius: var(--radius);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
	}
	.bar {
		width: 18px;
		height: 3px;
		border-radius: 999px;
	}
	.tone {
		color: var(--fg-dim);
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.label {
		display: flex;
		justify-content: space-between;
	}
	.label em {
		font-style: normal;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	input[type='range'] {
		accent-color: var(--accent);
		width: 100%;
	}

	.colours {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: var(--space-2);
	}
	.colour {
		flex-direction: row;
		align-items: center;
		gap: var(--space-2);
	}
	input[type='color'] {
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: none;
		cursor: pointer;
		flex: none;
	}
	.colour span {
		display: flex;
		flex-direction: column;
		color: var(--fg);
		font-size: var(--text-xs);
	}
	.colour code {
		color: var(--fg-dim);
		font-size: 0.65rem;
	}

	.preview .pane {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.pfg {
		margin: 0;
		color: var(--fg);
	}
	.pdim {
		margin: 0;
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.prow {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.pdanger {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.paper {
		background: var(--notation-paper);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
	}
	.ink {
		color: var(--notation);
		font-size: calc(var(--text-sm) * var(--notation-scale, 1));
	}
	.chip {
		font-size: var(--text-xs);
		padding: 2px var(--space-2);
		border-radius: var(--radius);
		color: var(--bg);
	}
	.add {
		background: var(--diff-add);
	}
	.change {
		background: var(--diff-change);
	}
	.remove {
		background: var(--diff-remove);
	}

	.msg {
		margin: 0;
		font-size: var(--text-sm);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
	}
</style>
