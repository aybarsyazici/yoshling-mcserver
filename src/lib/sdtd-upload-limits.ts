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

/**
 * The cap as it is written in user-facing copy. Kept next to the number it describes.
 *
 * **"1.86 GiB", not "2 GB"**, because the app's own `formatBytes` is binary and labels
 * GiB. The first version said "2 GB" beside a size rendered with `formatBytes`, so every
 * refused file between 1.86 and 2.00 GiB produced "That file is 1.96 GiB — the limit is
 * 2 GB", which reads as 1.96 being under 2. `format.ts`'s own docstring records this exact
 * trap as already paid for once ("the unit label has to match the arithmetic … every
 * backup summary understated its own file by ~5%"), and this is the second instance.
 *
 * The decimal 2 GB stays in the comment above, where it belongs: it is Caddy's number,
 * not the user's.
 */
export const MAX_WORLD_UPLOAD_LABEL = "1.86 GiB";

/** Separate from compressed transfer size: extraction must leave working disk space. */
export const MAX_WORLD_EXPANDED_BYTES = 8 * 1024 ** 3;
export const MAX_WORLD_EXPANDED_ENTRIES = 250_000;
export const WORLD_UPLOAD_DISK_RESERVE_BYTES = 1024 ** 3;
