/**
 * Mount prefix for emitted URLs.
 *
 * Empty when the app owns its origin (`node src/server.ts` → http://localhost:3000).
 * Set to e.g. `/todo` when a reverse proxy serves it under a path on a shared
 * host. Only *emitted* URLs carry it — the proxy strips the prefix before the
 * request reaches us, so the router keeps matching plain absolute paths.
 */
export const B = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");
