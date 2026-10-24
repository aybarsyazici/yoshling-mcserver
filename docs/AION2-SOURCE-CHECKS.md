# Aion source fingerprints

Source checks compare reviewed content with the current HTTP response. A change
withholds guidance until reviewed. Download/structure failures cannot approve new
content. Catalog and source expiry remain separate requirements.

## Default and scoped fingerprints

The default SHA-256 input is the complete response bytes. Official patch bodies
retain their existing explicitly defined body fingerprint. Sources use the default
unless an implemented, validated scope is explicitly selected in the catalog.

`hashScope: "html-main-v1"` is allowed only for this exact source URL:
<https://aion2.gg/database/skills/overhead-slam-11170000>.
It fingerprints the complete inner HTML of the single main element, byte-for-byte
after strict UTF-8 decoding. It does not reduce the page to selected keywords,
remove arbitrary script blocks or silently fall back to another hash input.
Missing, nested, duplicate, malformed or undecodable main content fails verification.
The runtime and maintenance CLI share the same extraction function.
The extractor is conservative for this known page format: unsupported raw-text
or namespace ambiguity and malformed boundary/comment terminators are rejected.

An invalid scoped response immediately makes source status unverified, including
after a previous successful check. A subsequent complete successful source check
may recover that unverified state. A verified content change still latches review
required until a new reviewed catalog combination is deployed. Ordinary network
failures retain the previous verified result for the existing maximum one hour;
request deadlines and catalog expiry are unchanged.
An already observed official patch-feed change is latched before fetching the
remaining references; an unrelated download failure cannot present it as current.

Do not add a scope merely to make a failing pin pass. Preserve raw old/new bodies,
review every relied-on fact and confirm the proposed fingerprint includes it.
An unrecognized scope or a scope attached to a different URL is invalid configuration.
Future sources require their own review and implementation before changing scope.

## October 24 false-change investigation

The live helper's unavailable warning was reproduced at 10:38 UTC. The Overhead
Slam source intermittently returned two successful, equally sized HTML responses:

| Response | Bytes | Complete-response SHA-256 |
| --- | ---: | --- |
| Reviewed/local variant | 122,030 | `d63d5481d03f66a58f81774d22d25eecc738bd6d683f1e09cb2764ee9fa03d6a` |
| Captured production variant | 122,030 | `07b7e62c078657aae01fde4897b4552712ca0597a45c3c687812cea21659f94c` |

Production returned the second variant on three consecutive reads, while another
source check and local/curl reads returned the first. The complete main content is
identical in both: 32,447 UTF-8 bytes, SHA-256
`e952c04bec1d940bd15a968e15fcbc2e2fab99378b966da37248e4972d1951d3`.
It includes all relied-on skill claims, specialty breakpoints, bonus-level sources
and the complete level table. Resolving all 62 Next.js transport records also
produced identical data; only record order and reference numbering varied.

The raw whole-page hash therefore treated rendering transport changes as a guide
update. Release `2026.10.24.3` reviews and pins the complete main content for this
source alone. No gameplay recommendation, skill breakpoint or expiry was changed.
The prior version's review hold was expected behavior given its raw input; clearing
that hold without reviewing the mismatch would not have established correctness.

Private evidence is under `/tmp/aion2-overhead-drift-20261024/` and
`/tmp/aion2-overhead-prod-captures/`, including both raw responses, extracted main
content, request metadata and resolved-record equivalence. No player/account data
or credentials were used in that comparison.

## Verification

All 3,939 tests across 215 files passed, including the transport-variant, real-change
latch, malformed-after-success, recovery and known-patch/partial-failure cases.
Five protection mutations failed as expected and were restored byte-for-byte.
The normal production build/artifact guard passed with the existing 13 tracing
warnings. TypeScript passed; lint passed with the existing seven warnings.
Native Node 22 extraction of both actual captured variants returned the
same reviewed 32,447-byte hash.

Before rollout, the corrected routine was also bundled and run in an isolated Node
process inside production: all 51 HTTP requests matched in 2.90 seconds. It produced
knowledge `2026.10.24.3` current, a valid current 23-row gear report and three plans
from the example's 10:43 UTC stored public observation. The connection was read-only.
This is a server-side projection check; it does not establish a signed-in browser
interaction or inspect the earlier web process's latched state.

The metadata-only index rebuild reused all 96 vectors with zero model calls or
input tokens. No game fact, progression instruction, timer, checklist or gear
catalog entry changed, and the October 28 review expiry remains unchanged.

### Production rollout

Commit `9f5debf` was pushed and deployed through
`scripts/deploy.sh --service web --verify '2026.10.24.3'`. Web image
`sha256:d3cf8a82cbd38f6308b2bb9804e6f1cf9009c10af096dc4ba2c5c72df7f46691`
started at 10:58:58 UTC. The new version, scoped-source implementation and gear
status labels were read back from the running built files.

At 10:59 UTC, the post-deployment isolated runtime probe matched all 51 requests
in 3.23 seconds and returned current knowledge, a valid current 23-row gear report
and three progression plans. The native source CLI inside the running container
also passed all four catalogs. Anonymous live HTTP checks returned login 200,
helper 307 to login and protected APIs 401 with private/no-store caching. All game
container IDs, image IDs, states and start times matched the pre-deploy baseline.
No migration, account authorization or game lifecycle change was made. Signed-in
browser interaction remains a verification limit.
