/**
 * The world-upload size cap, shared by the route and the uploader card.
 *
 * Client-safe on purpose — no imports, so the `"use client"` component can hold the same
 * number the server enforces. It used to exist only inside the route, which meant the
 * browser happily spent twenty minutes sending a file the server would refuse on arrival.
 *
 * ## Why 2,000,000,000 and not 2 GiB
 *
 * Large uploads do not go through Cloudflare (it caps requests at 100 MB); they go to
 * `direct.yoshling.xyz`, where Caddy is configured with `request_body { max_size 2GB }`.
 * **Caddy parses `2GB` as decimal**, which is 147,483,648 bytes *less* than the
 * `2 * 1024 * 1024 * 1024` the route used to allow. Verified on the box rather than
 * assumed, 2026-09-30:
 *
 *     caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile | grep max_size
 *     "max_size":2000000000
 *
 * So a file in that 147 MB window passed the app's own check and was then cut off by the
 * proxy — and the uploader's 413 branch explained it as "the direct-upload host may not
 * be configured", which is the wrong diagnosis for the one case it actually fires on.
 * Matching the proxy makes the app's limit the limit that bites, so the message the user
 * gets is the true one. Nothing becomes un-uploadable: nothing in that window could ever
 * have reached the route.
 *
 * If Caddy's `max_size` is ever raised, raise this with it — and to avoid this trap a
 * second time, write it there as `2GiB` so the two are the same number in both places.
 */
export const MAX_WORLD_UPLOAD_BYTES = 2_000_000_000;

/** The cap as it is written in user-facing copy. Kept next to the number it describes. */
export const MAX_WORLD_UPLOAD_LABEL = "2 GB";
