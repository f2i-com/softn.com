/**
 * What a host needs to edit an app while it runs, and nothing a host that
 * only runs one does (`@softn/core/edit`): which node drew an element, and
 * which file each stretch of the composed page was written in. No other
 * entry imports this, so a build that does not ask for it does not carry it;
 * a runtime asks for it when a person presses Edit.
 */

export { createEditMarks, drawnAt, drawnFrom, type DrawnFrom, type EditMarks } from './edit-marks';
export { composeBundleOrigins, originOf, placesOf, type ComposedWithOrigins, type SourceOrigin } from './source-origins';
