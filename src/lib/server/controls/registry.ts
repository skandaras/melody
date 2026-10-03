import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import type { Stage } from '$lib/pipeline/types.js';
import { controls, type ControlKind } from '../db/schema.js';

/**
 * Reading the control rack.
 *
 * Controls are rows, not code — which is the whole point of the `prompt` tier:
 * a new one can be added from the admin panel with no deploy. This module is
 * the read side; execution lives in `run.ts`.
 */

export interface ControlSummary {
	id: string;
	name: string;
	category: string;
	kind: ControlKind;
	icon: string | null;
	description: string;
	paramsSchema: Record<string, unknown> | null;
	defaultParams: Record<string, unknown> | null;
	/** True when this control costs nothing and works with no API key. */
	free: boolean;
	/** Where it is offered. Null or empty means every stage. */
	stages: Stage[] | null;
}

/**
 * The enabled controls, optionally only those a stage offers.
 *
 * No stage means all of them, which is what the free-form editor shows.
 * Filtered here rather than in SQL because `stages` is a JSON column, and the
 * whole table is a few dozen rows.
 */
export function listControls(stage?: Stage): ControlSummary[] {
	return db
		.select()
		.from(controls)
		.where(eq(controls.enabled, true))
		.orderBy(asc(controls.category), asc(controls.sortOrder))
		.all()
		.filter((c) => !stage || offeredAt(c.stages, stage))
		.map((c) => ({
			id: c.id,
			name: c.name,
			category: c.category,
			kind: c.kind,
			icon: c.icon,
			description: c.description,
			paramsSchema: c.paramsSchema,
			defaultParams: c.defaultParams,
			free: c.kind === 'code',
			stages: c.stages ?? null
		}));
}

/** Null and empty both mean everywhere; see the column. */
export function offeredAt(stages: readonly string[] | null | undefined, stage: Stage): boolean {
	return !stages?.length || stages.includes(stage);
}

export function getControl(id: string) {
	return db.select().from(controls).where(eq(controls.id, id)).get();
}
