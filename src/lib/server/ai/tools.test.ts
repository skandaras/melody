import { describe, it, expect } from 'vitest';
import { agentTools, opTools, READ_TOOLS, toStrictSchema } from './tools.js';
import { OPS } from '$lib/score/ops/index.js';

/**
 * Strict function calling rejects a narrower JSON Schema than we author, and
 * the failure mode is a 400 on every request rather than a bad edit — so these
 * assertions walk the whole generated tree rather than spot-checking one op.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every schema node in a generated tool, so assertions can cover nesting. */
function walk(node: unknown, visit: (n: Json) => void): void {
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit);
		return;
	}
	if (!isObject(node)) return;
	visit(node);
	for (const value of Object.values(node)) walk(value, visit);
}

const BANNED = [
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
	'maxProperties'
];

describe('toStrictSchema', () => {
	it('strips bounds and says them in the description instead', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: {
				semitones: { type: 'integer', minimum: -24, maximum: 24, description: 'Shift by.' }
			},
			required: ['semitones'],
			additionalProperties: false
		}) as Json;

		const prop = (out.properties as Json).semitones as Json;
		expect(prop.minimum).toBeUndefined();
		expect(prop.maximum).toBeUndefined();
		expect(prop.description).toBe('Shift by. Range -24 to 24.');
	});

	it('describes a bound even when the property had no description', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { n: { type: 'integer', minimum: 0 } },
			required: ['n'],
			additionalProperties: false
		}) as Json;
		expect(((out.properties as Json).n as Json).description).toBe('Minimum 0.');
	});

	it('makes optional properties nullable and lists every property as required', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: {
				partId: { type: 'string' },
				volume: { type: 'number' }
			},
			required: ['partId'],
			additionalProperties: false
		}) as Json;

		expect(out.required).toEqual(['partId', 'volume']);
		expect(((out.properties as Json).partId as Json).type).toBe('string');
		expect(((out.properties as Json).volume as Json).type).toEqual(['number', 'null']);
	});

	it('widens an optional enum to admit null as well', () => {
		// A property typed ["string","null"] whose enum omits null can never
		// legally be absent — the model is forced to pick a value.
		const out = toStrictSchema({
			type: 'object',
			properties: { clef: { type: 'string', enum: ['treble', 'bass'] } },
			required: [],
			additionalProperties: false
		}) as Json;

		const clef = (out.properties as Json).clef as Json;
		expect(clef.type).toEqual(['string', 'null']);
		expect(clef.enum).toEqual(['treble', 'bass', null]);
	});

	it('leaves a required enum alone', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { mode: { type: 'string', enum: ['major', 'minor'] } },
			required: ['mode'],
			additionalProperties: false
		}) as Json;

		const mode = (out.properties as Json).mode as Json;
		expect(mode.type).toBe('string');
		expect(mode.enum).toEqual(['major', 'minor']);
	});

	it('does not double-wrap an already-nullable type', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: { x: { type: ['string', 'null'] } },
			required: [],
			additionalProperties: false
		}) as Json;
		expect(((out.properties as Json).x as Json).type).toEqual(['string', 'null']);
	});

	it('recurses into nested objects and array items', () => {
		const out = toStrictSchema({
			type: 'object',
			properties: {
				notes: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: { tick: { type: 'integer', minimum: 0 } },
						required: ['tick']
					}
				}
			},
			required: ['notes'],
			additionalProperties: false
		}) as Json;

		const notes = (out.properties as Json).notes as Json;
		expect(notes.minItems).toBeUndefined();
		const item = notes.items as Json;
		expect(item.additionalProperties).toBe(false);
		expect((item.properties as Json).tick).toEqual({
			type: 'integer',
			description: 'Minimum 0.'
		});
	});

	it('leaves values that are not schema nodes alone', () => {
		const out = toStrictSchema({
			type: 'string',
			enum: ['a', 'b', 'c']
		}) as Json;
		expect(out.enum).toEqual(['a', 'b', 'c']);
	});
});

describe('opTools', () => {
	const tools = opTools();

	it('produces exactly one tool per registered operation', () => {
		expect(tools).toHaveLength(OPS.length);
		expect(tools.map((t) => t.function.name).sort()).toEqual(OPS.map((o) => o.name).sort());
	});

	it('carries the op summary as the description — the main steer on tool choice', () => {
		for (const tool of tools) {
			expect(tool.function.description.length).toBeGreaterThan(20);
		}
	});

	it('contains no keyword strict mode rejects, at any depth', () => {
		for (const tool of tools) {
			walk(tool.function.parameters, (node) => {
				for (const key of BANNED) {
					expect(
						{ tool: tool.function.name, key, present: key in node },
						`${tool.function.name} still has "${key}"`
					).toEqual({ tool: tool.function.name, key, present: false });
				}
			});
		}
	});

	it('sets additionalProperties false on every object, including nested ones', () => {
		for (const tool of tools) {
			walk(tool.function.parameters, (node) => {
				if (node.type === 'object' && isObject(node.properties)) {
					expect(node.additionalProperties, tool.function.name).toBe(false);
				}
			});
		}
	});

	it('lists every property as required, at every depth', () => {
		for (const tool of tools) {
			walk(tool.function.parameters, (node) => {
				if (node.type === 'object' && isObject(node.properties)) {
					expect(new Set(node.required as string[]), tool.function.name).toEqual(
						new Set(Object.keys(node.properties))
					);
				}
			});
		}
	});

	it('never leaves a nullable property with an enum that excludes null', () => {
		for (const tool of agentTools()) {
			walk(tool.function.parameters, (node) => {
				const nullableType = Array.isArray(node.type) && node.type.includes('null');
				if (nullableType && Array.isArray(node.enum)) {
					expect(node.enum, tool.function.name).toContain(null);
				}
			});
		}
	});

	it('marks every property that was not originally required as nullable', () => {
		for (const op of OPS) {
			const original = op.schema;
			const generated = tools.find((t) => t.function.name === op.name)!.function.parameters as Json;
			const props = generated.properties as Json;
			for (const name of Object.keys(original.properties)) {
				if (original.required.includes(name)) continue;
				const type = (props[name] as Json).type;
				expect(Array.isArray(type) && type.includes('null'), `${op.name}.${name}`).toBe(true);
			}
		}
	});

	it('is sorted and deterministic, so the cached prefix survives', () => {
		const names = tools.map((t) => t.function.name);
		expect(names).toEqual([...names].sort());
		expect(JSON.stringify(opTools())).toBe(JSON.stringify(tools));
	});

	it('preserves required properties as non-nullable', () => {
		const insert = tools.find((t) => t.function.name === 'insert_notes')!;
		const props = (insert.function.parameters as Json).properties as Json;
		expect((props.partId as Json).type).toBe('string');
	});
});

describe('read tools', () => {
	it('are strict and self-consistent too', () => {
		for (const tool of READ_TOOLS) {
			walk(tool.function.parameters, (node) => {
				if (node.type === 'object' && isObject(node.properties)) {
					expect(node.additionalProperties).toBe(false);
					expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties)));
				}
			});
		}
	});

	it('accept a no-argument call', () => {
		const list = READ_TOOLS.find((t) => t.function.name === 'list_instruments')!;
		expect(list.function.parameters).toMatchObject({ properties: {}, required: [] });
	});
});

describe('agentTools', () => {
	it('is the read tools plus every op, sorted', () => {
		const all = agentTools();
		expect(all).toHaveLength(OPS.length + READ_TOOLS.length);
		const names = all.map((t) => t.function.name);
		expect(names).toEqual([...names].sort());
		expect(new Set(names).size).toBe(names.length);
	});
});
