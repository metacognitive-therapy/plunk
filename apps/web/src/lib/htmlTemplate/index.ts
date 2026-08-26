/**
 * The parse5-free surface. `regions.ts` is deliberately NOT re-exported here:
 * importing it pulls parse5 into whatever chunk the importer lands in, and it is
 * only ever needed by the editor. Reach it with a dynamic
 * `import('./htmlTemplate/regions')` from the editor instead.
 */
export {REGION_ATTR, type EditableRegion, type RegionEdit, type RegionKind} from './types';
export {stripRegionMarkers} from './markers';
export {sanitizeForRender} from './sanitize';
