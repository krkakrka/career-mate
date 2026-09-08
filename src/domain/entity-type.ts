export const ENTITY_TYPES = ['company', 'role'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
