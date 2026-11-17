export const PUBLIC_VISITOR_TTL_MS = 6 * 60 * 60 * 1000;
export const PUBLIC_VISITOR_SWEEP_MS = 60 * 60 * 1000;

export function isPublicVisitor(username: string): boolean {
  return /@public\.ibero-data$/i.test(username);
}
