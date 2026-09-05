<script lang="ts">
	import { goto } from '$app/navigation';
	import AudioInput from '$lib/components/AudioInput.svelte';
	import { ScoreSession } from '$lib/editor/session.svelte';
	import { untrack } from 'svelte';
	import {
		emptyBrief,
		isBriefUsable,
		SEED_ROLES,
		SEED_ROLE_LABELS,
		type Brief,
		type SeedRole
	} from '$lib/pipeline/types';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage one: say what you want.
	 *
	 * The first thing melody asks rather than the last — the old front door was
	 * an empty editor with a blank canvas and thirty tools, which told you
	 * nothing about what to do next.
	 *
	 * Written words and a hummed melody are both complete briefs, and either
	 * alone is enough. The chips exist because a description usually leaves the
	 * same handful of things implicit; every one of them can be typed instead.
	 */

	let { data }: { data: PageServerData } = $props();

	// svelte-ignore state_referenced_locally
	const session = new ScoreSession(untrack(() => ({ ...data, revisions: [] })));

	// Initial value only: the field is edited locally from here on, and
	// re-deriving it from the load would discard what was being typed.
	let brief = $state<Brief>(untrack(() => ({ ...emptyBrief(), ...(data.pipeline.brief ?? {}) })));
	let saving = $state(false);
	let error = $state('');

	const hasSeed = $derived(Boolean(brief.seedPartId));
	const canContinue = $derived(isBriefUsable(brief) && !saving);

	/**
	 * A recorded or uploaded take.
	 *
	 * Seeded *before* planning deliberately: mergeParts adopts the incoming
	 * tempo only when the score has no parts yet, so seeding after a plan had
	 * set the tempo would silently discard what was detected from the audio.
	 */
	async function onTranscribed(fragment: Score, label: string) {
		await session.merge(fragment, `Transcribed ${label}`);
		// F0 added `created` for exactly this: without it there is no way to say
		// which part the seed became, and later stages cannot point at "the
		// theme" at all.
		const part = session.lastCreated.find((c) => c.kind === 'part');
		brief = { ...brief, seedPartId: part?.id, seedRole: brief.seedRole ?? 'theme' };
	}

	async function save(advance: boolean) {
		saving = true;
		error = '';
		try {
			const res = await fetch(`/api/scores/${data.score.id}/brief`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ brief, advance, stage: advance ? 'plan' : undefined })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);

			// The plan stage does not exist yet, so continuing hands off to the
			// editor. When it does, this becomes /plan and the brief finally has
			// a consumer.
			await goto(`/score/${data.score.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			saving = false;
		}
	}
</script>

<svelte:head><title>Brief · melody</title></svelte:head>

<div class="brief">
	<header>
		<p class="step">Brief</p>
		<h1>What are we making?</h1>
		<p class="lead">
			Describe it, hum it, or both. Everything after this is shaped by what you put here — and
			you can come back and change it.
		</p>
	</header>

	<section>
		<label class="field">
			<span class="label">Describe the piece</span>
			<textarea
				bind:value={brief.description}
				rows="5"
				placeholder="A slow waltz that sounds like rain on a window — piano and cello, about two minutes, never quite resolving."
			></textarea>
		</label>

		<div class="chips">
			<label class="chip">
				<span>Mood</span>
				<input type="text" bind:value={brief.mood} placeholder="wistful" />
			</label>
			<label class="chip">
				<span>Instruments</span>
				<input type="text" bind:value={brief.ensemble} placeholder="piano and cello" />
			</label>
			<label class="chip">
				<span>Length</span>
				<input
					type="number"
					min="4"
					max="512"
					value={brief.lengthBars ?? ''}
					oninput={(e) => {
						const n = Number.parseInt(e.currentTarget.value, 10);
						brief = { ...brief, lengthBars: Number.isFinite(n) ? n : undefined };
					}}
					placeholder="bars"
				/>
			</label>
			{#if data.styles.length}
				<label class="chip">
					<span>Reference</span>
					<select
						value={brief.referenceStyle ?? ''}
						onchange={(e) =>
							(brief = { ...brief, referenceStyle: e.currentTarget.value || undefined })}
					>
						<option value="">none</option>
						{#each data.styles as style (style)}
							<option value={style}>{style}</option>
						{/each}
					</select>
				</label>
			{/if}
		</div>
	</section>

	<section>
		<h2>Start from something you played</h2>
		<p class="hint">
			Optional. Hum, sing or drop in a recording and it becomes notation — no model, no API key,
			nothing leaves the browser until you continue.
		</p>

		<AudioInput
			ontranscribed={onTranscribed}
			disabled={saving}
			settings={data.transcribe}
			countInBars={data.countInBars}
			recordingUrl={data.recordingUrl}
		/>

		{#if hasSeed}
			<fieldset class="role">
				<legend>What is it?</legend>
				<!-- Asked rather than guessed: compose_plan's prompt requires the
				     seed to have a defined role, so the alternative is the model
				     inventing one. -->
				{#each SEED_ROLES as role (role)}
					<label>
						<input
							type="radio"
							name="seed-role"
							value={role}
							checked={brief.seedRole === role}
							onchange={() => (brief = { ...brief, seedRole: role as SeedRole })}
						/>
						<span>{SEED_ROLE_LABELS[role]}</span>
					</label>
				{/each}
			</fieldset>
		{/if}
	</section>

	{#if error || session.error}
		<p class="banner">{error || session.error}</p>
	{/if}

	<footer>
		<a class="skip" href="/score/{data.score.id}">Skip to the editor</a>
		<div class="spacer"></div>
		<button class="btn" onclick={() => save(false)} disabled={saving}>Save draft</button>
		<button class="btn primary" onclick={() => save(true)} disabled={!canContinue}>
			{saving ? 'Saving…' : 'Continue'}
		</button>
	</footer>
</div>

<style>
	.brief {
		max-width: 44rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-8);
		padding-bottom: var(--space-8);
	}

	.step {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--accent);
		margin-bottom: var(--space-2);
	}
	h1 {
		font-size: var(--text-xl);
		margin-bottom: var(--space-2);
	}
	.lead {
		color: var(--fg-dim);
		max-width: 34rem;
	}

	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	h2 {
		font-size: var(--text-lg);
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
		max-width: 34rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.label {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	textarea {
		width: 100%;
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		font: inherit;
		resize: vertical;
	}
	textarea:focus,
	input:focus,
	select:focus {
		outline: none;
		border-color: var(--accent);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.chip {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: var(--space-1) var(--space-3);
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.chip input,
	.chip select {
		background: none;
		border: none;
		color: var(--fg);
		font: inherit;
		width: 9rem;
	}
	.chip input[type='number'] {
		width: 4rem;
	}

	.role {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
	}
	.role legend {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		padding: 0 var(--space-2);
	}
	.role label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}

	.banner {
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
		padding: var(--space-3);
		border-radius: var(--radius);
	}

	footer {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		border-top: 1px solid var(--border);
		padding-top: var(--space-4);
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.skip {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
		font: inherit;
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
</style>
