import { OPS } from '$lib/score/ops/index.js';
import { GM_INSTRUMENTS } from '$lib/score/instruments.js';

/**
 * The score operations, as function definitions a model can call.
 *
 * This is generated from the op registry rather than hand-maintained, so a new
 * operation becomes callable the moment it is registered — that is the whole
 * point of the registry being the extension seam.
 *
 * The generation is not a straight copy, because strict function calling
 * accepts a narrower JSON Schema than we author:
 *
 *   - every property must appear in `required`; optional ones become nullable
 *   - `additionalProperties: false` on every object, nested ones included
 *   - no minimum/maximum/minItems/maxItems/minLength/maxLength/multipleOf/pattern
 *
 * Stripping the bounds loses nothing at runtime: every op already clamps its
 * own arguments (clampMidi, clampVel, and the Math.max/min guards inside each
 * apply), so the schema was documenting the range, not enforcing it. The range
 * is folded into the property description instead, where it still steers the
 * model and cannot cause a 400.
 */

export interface FunctionDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		strict: true;
	};
}

/** Schema keywords strict mode rejects, and how to phrase each one in prose. */
const BOUND_KEYWORDS = [
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minItems',
	'maxItems',
	'uniqueItems',
	'minLength',
	'maxLength',
	'pattern',
	'minProperties',
	'maxProperties',
	'patternProperties',
	'propertyNames',
	'default',
	'examples'
] as const;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Turn a stripped bound back into words, so the model still knows the range.
 * Appended to the description rather than dropped silently — an op whose
 * `semitones` must sit in -24..24 is much easier to call correctly when that
 * is said out loud.
 */
function describeBounds(node: Json): string {
	const parts: string[] = [];
	const { minimum, maximum, minItems, maxItems, minLength, maxLength } = node as Record<
		string,
		number | undefined
	>;

	if (minimum != null && maximum != null) parts.push(`Range ${minimum} to ${maximum}.`);
	else if (minimum != null) parts.push(`Minimum ${minimum}.`);
	else if (maximum != null) parts.push(`Maximum ${maximum}.`);

	if (minItems != null && minItems > 0) {
		parts.push(`At least ${minItems} item${minItems === 1 ? '' : 's'}.`);
	}
	if (maxItems != null) parts.push(`At most ${maxItems} items.`);
	if (minLength != null && minLength > 0) parts.push(`At least ${minLength} characters.`);
	if (maxLength != null) parts.push(`At most ${maxLength} characters.`);

	return parts.join(' ');
}

/**
 * Rewrite one schema node for strict mode.
 *
 * Recursive because the op schemas nest: `insert_notes` has an array of note
 * objects, and `selection` is a shared object fragment reused across a dozen
 * ops. Every level has to satisfy the same rules.
 */
export function toStrictSchema(input: unknown): unknown {
	if (Array.isArray(input)) return input.map(toStrictSchema);
	if (!isObject(input)) return input;

	const node: Json = {};
	const bounds = describeBounds(input);

	for (const [key, value] of Object.entries(input)) {
		if ((BOUND_KEYWORDS as readonly string[]).includes(key)) continue;
		if (key === 'properties' && isObject(value)) {
			const props: Json = {};
			for (const [name, sub] of Object.entries(value)) props[name] = toStrictSchema(sub);
			node.properties = props;
			continue;
		}
		if (key === 'items') {
			node.items = toStrictSchema(value);
			continue;
		}
		node[key] = toStrictSchema(value);
	}

	if (bounds) {
		const existing = typeof node.description === 'string' ? node.description : '';
		node.description = existing ? `${existing} ${bounds}` : bounds;
	}

	if (node.type === 'object' && isObject(node.properties)) {
		node.additionalProperties = false;
		// Strict mode requires every property to be listed as required. An
		// argument that is genuinely optional therefore has to be expressible
		// as null, and each op already treats a missing value and an explicit
		// null the same way (`args.x != null` guards throughout).
		const all = Object.keys(node.properties);
		const wasRequired = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
		for (const name of all) {
			if (wasRequired.has(name)) continue;
			const prop = node.properties[name];
			if (isObject(prop)) makeNullable(prop);
		}
		node.required = all;
	}

	return node;
}

/**
 * Widen a property so it can legally be omitted.
 *
 * The enum half matters as much as the type half: a property typed
 * `["string","null"]` whose enum still lists only real values can never
 * validly be null, so the model is forced to invent a value for an argument
 * the caller meant to leave alone. Both have to widen together.
 */
function makeNullable(prop: Json): void {
	if (prop.type != null) {
		prop.type = Array.isArray(prop.type)
			? prop.type.includes('null')
				? prop.type
				: [...prop.type, 'null']
			: [prop.type, 'null'];
	}
	if (Array.isArray(prop.enum) && !prop.enum.includes(null)) {
		prop.enum = [...prop.enum, null];
	}
}

/**
 * The score operations as tools, sorted by name.
 *
 * Sorted, and identical for every task, because tool definitions render at the
 * very front of the prompt: a tool list that varies between requests
 * invalidates the cached prefix behind it — system prompt and style skills
 * included. Scope differences belong in the system prompt, not here.
 */
export function opTools(): FunctionDef[] {
	return [...OPS]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((op) => ({
			type: 'function' as const,
			function: {
				name: op.name,
				description: op.summary,
				parameters: toStrictSchema(op.schema) as Record<string, unknown>,
				strict: true as const
			}
		}));
}

/**
 * Read-only tools, hand-written because they aren't operations.
 *
 * These exist so the model can look before it writes. Without them it either
 * works blind or we send the whole score every turn, and a score is hundreds
 * of KB — see context.ts for why that matters.
 */
export const READ_TOOLS: FunctionDef[] = [
	{
		type: 'function',
		function: {
			name: 'read_score',
			description:
				'Read the notes in a range of the score. Use this before editing to see what is actually there — the prompt only includes a summary and the current selection.',
			strict: true,
			parameters: {
				type: 'object',
				properties: {
					startTick: {
						type: ['integer', 'null'],
						description: 'First tick to read. Omit or null for the start of the piece.'
					},
					endTick: {
						type: ['integer', 'null'],
						description: 'Last tick to read. Omit or null for the end of the piece.'
					},
					partId: {
						type: ['string', 'null'],
						description: 'Restrict to one part. Omit or null for every part.'
					}
				},
				required: ['startTick', 'endTick', 'partId'],
				additionalProperties: false
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'analyse_range',
			description:
				'Detected key, chord progression, range and note density for part of the score. Cheaper and more reliable than working it out from the raw notes.',
			strict: true,
			parameters: {
				type: 'object',
				properties: {
					startTick: { type: ['integer', 'null'], description: 'Omit or null for the whole piece.' },
					endTick: { type: ['integer', 'null'], description: 'Omit or null for the whole piece.' }
				},
				required: ['startTick', 'endTick'],
				additionalProperties: false
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_instruments',
			description:
				'The General MIDI instrument names accepted by add_part and set_instrument. Call this rather than guessing a name.',
			strict: true,
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
		}
	}
];

/** Every tool an agent-tier control may call. */
export function agentTools(): FunctionDef[] {
	return [...READ_TOOLS, ...opTools()].sort((a, b) =>
		a.function.name.localeCompare(b.function.name)
	);
}

/** Names of the tools that only read. The loop uses this to decide what to
 *  answer inline and what to accumulate into a revision. */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set(READ_TOOLS.map((t) => t.function.name));

export const INSTRUMENT_NAMES = GM_INSTRUMENTS;
