import { asc, eq } from 'drizzle-orm';
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

export function listControls(): ControlSummary[] {
	return db
		.select()
		.from(controls)
		.where(eq(controls.enabled, true))
		.orderBy(asc(controls.category), asc(controls.sortOrder))
		.all()
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

export function getControl(id: string) {
	return db.select().from(controls).where(eq(controls.id, id)).get();
}
