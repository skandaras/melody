import { asc, eq } from 'drizzle-orm';
import { isStage, type Stage } from '$lib/pipeline/types.js';
import { db } from '../db/index.js';
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
}

/**
 * The rack, optionally scoped to one stage.
 *
 * Unscoped is the editor, which has always shown everything and still should.
 * Scoped is a stage page, where the point is that only the controls that mean
 * something at this moment are offered — 29 in one rack is the problem the
 * pipeline exists to solve, not a thing to reproduce six times.
 *
 * Filtered here rather than in SQL: `stages` is a JSON column, the rack is a
 * few dozen rows read once per page load, and `json_each` would trade a
 * legible three-line rule for a query that hides the null case.
 */
export function listControls(stage?: Stage): ControlSummary[] {
	return db
		.select()
		.from(controls)
		.where(eq(controls.enabled, true))
		.orderBy(asc(controls.category), asc(controls.sortOrder))
		.all()
		.filter((c) => offeredAt(c.stages, stage))
		.map((c) => ({
			id: c.id,
			name: c.name,
			category: c.category,
			kind: c.kind,
			icon: c.icon,
			description: c.description,
			paramsSchema: c.paramsSchema,
			defaultParams: c.defaultParams,
			free: c.kind === 'code'
		}));
}

/**
 * Whether a control's stage list offers it here.
 *
 * Null is every stage, which is what makes this an additive change: a row
 * written before the column existed, and a control someone adds from the admin
 * panel without thinking about stages, both keep appearing rather than
 * quietly disappearing. An empty list is the opposite and is deliberate — it
 * is how `Compose from seed` is retired from the staged flow while staying in
 * the editor.
 */
export function offeredAt(stages: string[] | null, stage?: Stage): boolean {
	if (!stage) return true;
	if (stages == null) return true;
	return stages.some((s) => isStage(s) && s === stage);
}

export function getControl(id: string) {
	return db.select().from(controls).where(eq(controls.id, id)).get();
}
