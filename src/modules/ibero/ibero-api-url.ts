/**
 * Base URL of the Ibero Data API, taken from IBERO_API_URL without trailing
 * slashes. It is the only Ibero Data instance this server talks to, so URLs
 * coming from the client are checked against it instead of being trusted.
 */
export function iberoApiUrl(): string | null {
  const raw = process.env.IBERO_API_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}
