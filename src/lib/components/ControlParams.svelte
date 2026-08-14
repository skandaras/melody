<script lang="ts">
	/**
	 * The form for one control's parameters, generated from its JSON Schema.
	 *
	 * Controls are database rows, so their parameters can't have hand-written
	 * forms — a control added from the admin panel with no deploy has to get a
	 * usable UI for free. The schema subset here is the one the seeded controls
	 * actually use: numbers with a range, enums, strings and booleans.
	 */

	interface Props {
		schema: Record<string, unknown> | null;
		values: Record<string, unknown>;
		disabled?: boolean;
		onchange: (values: Record<string, unknown>) => void;
	}
	let { schema, values, disabled = false, onchange }: Props = $props();

	interface Field {
		key: string;
		title: string;
		type: string;
		enum?: string[];
		min?: number;
		max?: number;
		step?: number;
		description?: string;
	}

	const fields = $derived.by<Field[]>(() => {
		const props = schema?.properties;
		if (!props || typeof props !== 'object') return [];

		return Object.entries(props as Record<string, Record<string, unknown>>).map(([key, spec]) => {
			const type = Array.isArray(spec.type) ? String(spec.type[0]) : String(spec.type ?? 'string');
			const options = Array.isArray(spec.enum)
				? (spec.enum.filter((v) => v != null) as string[])
				: undefined;
			return {
				key,
				title: typeof spec.title === 'string' ? spec.title : key,
				type,
				enum: options,
				min: typeof spec.minimum === 'number' ? spec.minimum : undefined,
				max: typeof spec.maximum === 'number' ? spec.maximum : undefined,
				// An integer slider that can land on 0.5 produces ops the score
				// model has to round anyway.
				step: type === 'integer' ? 1 : undefined,
				description: typeof spec.description === 'string' ? spec.description : undefined
			};
		});
	});

	function set(key: string, value: unknown) {
		onchange({ ...values, [key]: value });
	}

	/** A bounded number is a slider; an unbounded one is a box. */
	const isSlider = (f: Field) =>
		(f.type === 'integer' || f.type === 'number') && f.min != null && f.max != null;
</script>

{#if fields.length}
	<div class="params">
		{#each fields as field (field.key)}
			<label title={field.description}>
				<span class="label">
					{field.title}
					{#if isSlider(field)}
						<span class="value">{values[field.key] ?? field.min}</span>
					{/if}
				</span>

				{#if field.enum}
					<select
						value={String(values[field.key] ?? field.enum[0])}
						{disabled}
						onchange={(e) => set(field.key, e.currentTarget.value)}
					>
						{#each field.enum as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				{:else if isSlider(field)}
					<input
						type="range"
						min={field.min}
						max={field.max}
						step={field.step ?? 1}
						value={Number(values[field.key] ?? field.min)}
						{disabled}
						oninput={(e) => set(field.key, Number(e.currentTarget.value))}
					/>
				{:else if field.type === 'integer' || field.type === 'number'}
					<input
						type="number"
						value={Number(values[field.key] ?? 0)}
						step={field.step ?? 'any'}
						{disabled}
						oninput={(e) => set(field.key, Number(e.currentTarget.value))}
					/>
				{:else if field.type === 'boolean'}
					<input
						type="checkbox"
						checked={Boolean(values[field.key])}
						{disabled}
						onchange={(e) => set(field.key, e.currentTarget.checked)}
					/>
				{:else}
					<input
						type="text"
						value={String(values[field.key] ?? '')}
						{disabled}
						oninput={(e) => set(field.key, e.currentTarget.value)}
					/>
				{/if}
			</label>
		{/each}
	</div>
{/if}

<style>
	.params {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-2) 0 var(--space-1);
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
		gap: var(--space-2);
	}
	.value {
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	input[type='range'] {
		accent-color: var(--accent);
		width: 100%;
	}
	input[type='text'],
	input[type='number'],
	select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 2px 4px;
		font-size: var(--text-xs);
		width: 100%;
	}
	input[type='checkbox'] {
		align-self: flex-start;
		accent-color: var(--accent);
	}
</style>
