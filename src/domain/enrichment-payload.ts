import type { EnrichmentJobPayload } from '../daemon/handlers/enrichment.js';

/**
 * The one place enrichment job payloads are built.
 *
 * `enqueueJobOnce` debounces by comparing payload JSON verbatim, so two
 * callers that mean the same job must produce byte-identical payloads —
 * a stray `force: false` or a reordered key is enough to defeat it and let
 * every `cm companies show` queue another duplicate recompute. Centralizing
 * construction is what makes that guarantee hold; `force` is therefore
 * omitted entirely unless it is true, never written as `false`.
 */
export function companyStructuralPayload(companyId: number, force = false): EnrichmentJobPayload {
  return force ? { kind: 'company-structural', companyId, force: true } : { kind: 'company-structural', companyId };
}

export function roleStructuralPayload(roleId: number, force = false): EnrichmentJobPayload {
  return force ? { kind: 'role-structural', roleId, force: true } : { kind: 'role-structural', roleId };
}

export function companyResearchPayload(companyId: number): EnrichmentJobPayload {
  return { kind: 'company-research', companyId };
}

export function roleResearchPayload(roleId: number): EnrichmentJobPayload {
  return { kind: 'role-research', roleId };
}

export function companyWlbPayload(companyId: number): EnrichmentJobPayload {
  return { kind: 'company-wlb', companyId };
}
