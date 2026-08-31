import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { controls, type ControlKind } from '../db/schema.js';
import { OP_MAP } from '$lib/score/ops/index.js';

/**
 * Admin CRUD for the control rack.
 *
 * The kind split is the architectural one from builtin.ts, and editing respects
 * it: `code` controls run a registry op, so there is no prompt to edit — only
 * their display fields, default params and enabled flag. `prompt` and `agent`
 * controls are pure data, so all of it is editable, and a new one can be added
 * from this panel with no deploy.
 */

/** What the list shows; same shape the run path resolves, plus enabled. */
export interface AdminControlView {
	id: string;
	name: string;
	category: string;
	kind: ControlKind;
	icon: string | null;
	description: string;
	opName: string | null;
	promptTemplate: string | null;
	systemPrompt: string | null;
	paramsSchema: Record<string, unknown> | null;
	defaultParams: Record<string, unknown> | null;
	builtin: boolean;
	enabled: boolean;
	sortOrder: number;
}

function view(c: typeof controls.$inferSelect): AdminControlView {
	return {
		id: c.id,
		name: c.name,
		category: c.category,
		kind: c.kind,
		icon: c.icon,
		description: c.description,
		opName: c.opName,
		promptTemplate: c.promptTemplate,
		systemPrompt: c.systemPrompt,
		paramsSchema: c.paramsSchema,
		defaultParams: c.defaultParams,
		builtin: c.builtin,
		enabled: c.enabled,
		sortOrder: c.sortOrder
	};
}

export function listAdminControls(): AdminControlView[] {
	return db.select().from(controls).orderBy(asc(controls.category), asc(controls.sortOrder)).all().map(view);
}

export class ControlValidationError extends Error {}

/** Rows a prompt/agent control must have. Built-ins can predate a schema. */
function validatePromptControl(patch: {
	promptTemplate?: string | null;
	paramsSchema?: Record<string, unknown> | null;
	defaultParams?: Record<string, unknown> | null;
}): void {
	const template = patch.promptTemplate?.trim();
	if (!template) throw new ControlValidationError('A prompt or agent control needs a prompt template.');
	if (template.length > 20_000) throw new ControlValidationError('The prompt template is too long.');

	const schema = patch.paramsSchema;
	if (schema && typeof schema !== 'object') {
		throw new ControlValidationError('The parameters schema must be a JSON object.');
	}
	if (schema && typeof schema === 'object' && 'type' in schema && schema.type !== 'object') {
		throw new ControlValidationError('The parameters schema must describe an object.');
	}

	const defaults = patch.defaultParams;
	if (defaults && typeof defaults === 'object') {
		const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
		for (const key of required) {
			if (!(key in defaults)) {
				throw new ControlValidationError(`Missing a default value for "${key}".`);
			}
		}
	}
}

export function updateControl(id: string, patch: Partial<AdminControlView>): AdminControlView {
	const row = db.select().from(controls).where(eq(controls.id, id)).get();
	if (!row) throw new ControlValidationError('Control not found.');

	const next: Partial<typeof controls.$inferInsert> = {};

	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name) throw new ControlValidationError('Name cannot be empty.');
		if (name.length > 60) throw new ControlValidationError('Name is too long.');
		next.name = name;
	}
	if (patch.category !== undefined) {
		const category = patch.category.trim();
		if (!category) throw new ControlValidationError('Category cannot be empty.');
		next.category = category.slice(0, 40);
	}
	if (patch.icon !== undefined) next.icon = patch.icon?.trim() || null;
	if (patch.description !== undefined) next.description = patch.description.trim();
	if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
	if (patch.sortOrder !== undefined) {
		next.sortOrder = Math.max(0, Math.min(9999, Math.round(Number(patch.sortOrder) || 0)));
	}
	if (patch.defaultParams !== undefined) {
		if (patch.defaultParams === null || typeof patch.defaultParams !== 'object') {
			throw new ControlValidationError('Default parameters must be an object.');
		}
		next.defaultParams = patch.defaultParams;
	}

	if (row.kind === 'code') {
		// A code control's opName is not editable — its behaviour is code in
		// the registry, not data here. paramsSchema stays too: the generated
		// form must keep matching what the op actually reads.
		if (patch.promptTemplate !== undefined || patch.systemPrompt !== undefined) {
			throw new ControlValidationError(
				'Code controls run a registered operation and have no prompt to edit.'
			);
		}
	} else {
		if (patch.promptTemplate !== undefined) next.promptTemplate = patch.promptTemplate ?? null;
		if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt?.trim() || null;
		if (patch.paramsSchema !== undefined) {
			if (patch.paramsSchema === null) {
				next.paramsSchema = null;
			} else if (typeof patch.paramsSchema === 'object') {
				next.paramsSchema = patch.paramsSchema;
			} else {
				throw new ControlValidationError('The parameters schema must be an object or null.');
			}
		}
		validatePromptControl({
			promptTemplate: next.promptTemplate ?? row.promptTemplate,
			paramsSchema: next.paramsSchema !== undefined ? next.paramsSchema : row.paramsSchema,
			defaultParams: next.defaultParams !== undefined ? next.defaultParams : row.defaultParams
		});
	}

	if (Object.keys(next).length) {
		db.update(controls).set(next).where(eq(controls.id, id)).run();
	}
	const updated = db.select().from(controls).where(eq(controls.id, id)).get();
	return view(updated!);
}

export interface CreateControlInput {
	name: string;
	category: string;
	kind: ControlKind;
	icon?: string | null;
	description?: string;
	promptTemplate: string;
	systemPrompt?: string | null;
	paramsSchema?: Record<string, unknown> | null;
	defaultParams?: Record<string, unknown> | null;
}

export function createControl(input: CreateControlInput): AdminControlView {
	if (input.kind === 'code') {
		// No UI path offers it, and there is no way to author the behaviour
		// from a panel — a code control is a deploy.
		throw new ControlValidationError('Code controls are part of the app and cannot be created here.');
	}
	if (input.kind !== 'prompt' && input.kind !== 'agent') {
		throw new ControlValidationError('Kind must be prompt or agent.');
	}

	const name = input.name?.trim();
	if (!name) throw new ControlValidationError('Name cannot be empty.');
	if (name.length > 60) throw new ControlValidationError('Name is too long.');

	validatePromptControl(input);

	// The rack groups by category; new categories just join the list sorted by
	// CONTROL_CATEGORIES's known ones first, then alphabetically.
	const last = db
		.select({ sortOrder: controls.sortOrder })
		.from(controls)
		.orderBy(asc(controls.sortOrder))
		.all()
		.at(-1);

	db.insert(controls)
		.values({
			id: randomUUID(),
			name,
			category: input.category.trim().slice(0, 40),
			kind: input.kind,
			icon: input.icon?.trim() || null,
			description: input.description?.trim() ?? '',
			opName: null,
			promptTemplate: input.promptTemplate,
			systemPrompt: input.systemPrompt?.trim() || null,
			paramsSchema: input.paramsSchema ?? null,
			defaultParams: input.defaultParams ?? null,
			builtin: false,
			enabled: true,
			sortOrder: (last?.sortOrder ?? 0) + 1
		})
		.run();

	const row = db.select().from(controls).where(eq(controls.name, name)).get();
	return view(row!);
}

/** Only user-created rows can be deleted; built-ins are disabled instead. */
export function deleteControl(id: string): void {
	const row = db.select().from(controls).where(eq(controls.id, id)).get();
	if (!row) throw new ControlValidationError('Control not found.');
	if (row.builtin) throw new ControlValidationError('Built-in controls can be disabled, not deleted.');
	db.delete(controls).where(eq(controls.id, id)).run();
}

/** Validity check for the admin form: a code control's op must exist. */
export function opExists(name: string): boolean {
	return OP_MAP.has(name);
}
