<script lang="ts">
	/**
	 * Note entry: what the mouse does, and what it writes.
	 *
	 * Two modes rather than a modifier key, because entry is a state people stay
	 * in for a while — a chord of held keys is fine for one note and miserable
	 * for a bar of them. This is how MuseScore and Dorico work, so the muscle
	 * memory transfers.
	 */

	export interface NoteEntry {
		/** Ticks, before dotting. A crotchet at ppq 480 is 480. */
		duration: number;
		dotted: boolean;
		/** Snap divisions per whole note. */
		grid: number;
		triplets: boolean;
		rest: boolean;
		/** Semitone offset applied to the clicked pitch, for accidentals. */
		accidental: -1 | 0 | 1;
	}

	interface Props {
		mode: 'select' | 'add';
		entry: NoteEntry;
		ppq: number;
		disabled?: boolean;
		onmode: (mode: 'select' | 'add') => void;
		onentry: (entry: NoteEntry) => void;
	}
	let { mode, entry, ppq, disabled = false, onmode, onentry }: Props = $props();

	// Note values as fractions of a whole note, so the tick figures follow ppq
	// rather than being written out for one resolution.
	const VALUES = [
		{ label: '𝅝', title: 'Semibreve', whole: 1 },
		{ label: '𝅗𝅥', title: 'Minim', whole: 2 },
		{ label: '♩', title: 'Crotchet', whole: 4 },
		{ label: '♪', title: 'Quaver', whole: 8 },
		{ label: '𝅘𝅥𝅯', title: 'Semiquaver', whole: 16 }
	];

	const ticksFor = (whole: number) => (ppq * 4) / whole;
	const set = (patch: Partial<NoteEntry>) => onentry({ ...entry, ...patch });

	const ACCIDENTALS = [
		{ value: -1 as const, label: '♭', title: 'Flatten the clicked pitch' },
		{ value: 0 as const, label: '♮', title: 'Take the pitch from the key signature' },
		{ value: 1 as const, label: '♯', title: 'Sharpen the clicked pitch' }
	];
</script>

<div class="palette">
	<div class="group modes" role="group" aria-label="Pointer mode">
		<button
			class="btn"
			class:on={mode === 'select'}
			onclick={() => onmode('select')}
			{disabled}
			title="Click notes to select them, drag to select several"
		>
			Select
		</button>
		<button
			class="btn"
			class:on={mode === 'add'}
			onclick={() => onmode('add')}
			{disabled}
			title="Click the stave to place a note"
		>
			Add note
		</button>
	</div>

	{#if mode === 'add'}
		<div class="group" role="group" aria-label="Note value">
			{#each VALUES as v (v.whole)}
				<button
					class="btn glyph"
					class:on={entry.duration === ticksFor(v.whole)}
					onclick={() => set({ duration: ticksFor(v.whole) })}
					title={v.title}
					aria-label={v.title}
					{disabled}
				>
					{v.label}
				</button>
			{/each}
			<button
				class="btn"
				class:on={entry.dotted}
				onclick={() => set({ dotted: !entry.dotted })}
				title="Dotted — half as long again"
				aria-label="Dotted"
				{disabled}
			>
				.
			</button>
		</div>

		<div class="group" role="group" aria-label="Accidental">
			{#each ACCIDENTALS as a (a.value)}
				<button
					class="btn glyph"
					class:on={entry.accidental === a.value}
					onclick={() => set({ accidental: a.value })}
					title={a.title}
					aria-label={a.title}
					{disabled}
				>
					{a.label}
				</button>
			{/each}
		</div>

		<div class="group" role="group" aria-label="Entry options">
			<button
				class="btn"
				class:on={entry.rest}
				onclick={() => set({ rest: !entry.rest })}
				title="Place rests instead of notes"
				{disabled}
			>
				Rest
			</button>
			<button
				class="btn"
				class:on={entry.triplets}
				onclick={() => set({ triplets: !entry.triplets })}
				title="Snap to triplet divisions"
				{disabled}
			>
				Triplet
			</button>
		</div>

		<label class="grid-pick">
			<span>Snap</span>
			<select
				value={entry.grid}
				onchange={(e) => set({ grid: Number(e.currentTarget.value) })}
				{disabled}
				aria-label="Snap grid"
			>
				<option value={4}>1/4</option>
				<option value={8}>1/8</option>
				<option value={16}>1/16</option>
				<option value={32}>1/32</option>
			</select>
		</label>
	{/if}
</div>

<style>
	.palette {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.group {
		display: flex;
		gap: 1px;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		cursor: pointer;
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-xs);
		border-radius: 0;
	}
	.group .btn:first-child {
		border-top-left-radius: var(--radius);
		border-bottom-left-radius: var(--radius);
	}
	.group .btn:last-child {
		border-top-right-radius: var(--radius);
		border-bottom-right-radius: var(--radius);
	}
	.btn.on {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.glyph {
		/* The music glyphs sit small and high in most UI faces, so give them
		   room and a consistent box rather than letting each one set the width. */
		font-size: var(--text-md);
		line-height: 1;
		min-width: 2rem;
		padding: 2px var(--space-1);
	}
	.grid-pick {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 2px 4px;
		font-size: var(--text-xs);
	}
</style>
