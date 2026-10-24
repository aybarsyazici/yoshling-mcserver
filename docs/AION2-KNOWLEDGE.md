# Reviewing and rebuilding Aion knowledge

The website applies reviewed rules to public character observations. Bedrock is a
build-time retrieval tool. It does not decide whether a claim is true, publish new
advice, or infer private game resources.

## What is saved

- `src/data/aion2/knowledge.json`: scoped sources, review/expiry dates, rules,
  milestones, activities, ordered recipes and Daevanion presets.
- `src/data/aion2/gear-priorities.json`: class/slot preferences, exact item pools,
  mechanics, conditions and scoped source pins; see [gear guidance](AION2-GEAR-PRIORITIES.md).
- `src/data/aion2/semantic-index.json`: normalized Titan embeddings of the authored
  game facts, pre-embedded progression questions, related evidence and similarity
  groups. It records the model, dimensions, combined knowledge/gear digest and build statistics.
- `src/data/aion2/timers.json`: reviewed event schedules with region/time-zone and
  provenance. Check its own sources when revising event times; a schedule is not
  evidence that a world boss is alive.

The initial embedding build used Titan Text Embeddings V2, 512 dimensions, in
`us-west-2`. It embedded 42 authored knowledge chunks plus six predefined progression
queries. The reviewed rebuild contains 54 chunks/six queries, reusing 31 vectors and
invoking the model for 29 changed/new texts. No player snapshot, checklist report,
identity, image, inventory or credential was sent as embedding input.
Similarity groups help a reviewer find related material; they are not truth or
confidence labels. Repeated claims from one author are not independent corroboration.

The site reads the saved index. It makes no AWS request. Runtime evidence selection
checks the exact combined knowledge/gear digest, class applicability and currently applicable step
IDs, so a later-stage or another class's advice cannot be attached just because its
embedding is similar. Rules and source expiry still control whether advice is shown.

## Update procedure

1. Read [the helper's source-review procedure](AION2-HELPER.md#updating-the-knowledge-base).
   Inspect new/revised official Global patches first. Check client-data reference
   versions and region scope. Review timer provider time zones and any DST assumptions.
2. Change only supported facts in the JSON. Keep entry requirements and reward cost
   in `activities`; steps reference the activity ID. Set class skill milestones and
   conditions explicitly. Give every step, board model and event its direct source.
   Retain uncertainty when the source or public API cannot establish a prerequisite.
3. Bump the knowledge version and update the reviewed source pins/dates after reading
   the changes. Pins hash raw response bytes unless an explicitly implemented scope
   is selected. Read [source fingerprints](AION2-SOURCE-CHECKS.md) before changing
   a scope; rendering differences must be proved separately from game-data changes. Run:

   ```bash
   npm run aion2:knowledge:validate
   npm run aion2:knowledge:check
   npm run aion2:knowledge:embed
   ```

   The last command is a dry run and uses no credentials. It shows the bounded batch.
4. For changed text, prefer an AWS CLI SSO profile using the refreshable
   `sso-session` configuration. The SSO Start URL and SSO Region come from the AWS
   access portal; the SSO Region can differ from the Bedrock invocation region.
   Configure/login locally, then run the bounded embedding build:

   ```bash
   aws configure sso --profile aion2-bedrock
   aws sso login --profile aion2-bedrock
   npm run aion2:knowledge:embed -- --build --profile aion2-bedrock --region us-west-2
   ```

   Choose the account/role authorized for this project. The commands do not create
   IAM permissions or grant model access. The
   [AWS token provider](https://docs.aws.amazon.com/sdkref/latest/guide/feature-sso-credentials.html)
   refreshes credentials within the SSO session; a new login is still needed when
   that session expires. SSO is not a permanent unattended workload identity.

   Explicit `--profile` takes priority over `AWS_PROFILE`/`AWS_DEFAULT_PROFILE`.
   A selected profile ignores legacy `.env` keys and removes ambient static key
   variables from the AWS child process, so expired copied keys cannot override SSO.
   Without a profile, complete environment credentials take priority over legacy
   `.env` keys; if neither exists, the normal AWS CLI provider chain is available.
   `.env` is optional. Existing lowercase temporary-key names remain supported.

   A cache-only build reads no credentials or `.env` and invokes no AWS command.
   A real cache miss resolves credentials once and invokes the local AWS CLI;
   secrets stay in its process environment, never command arguments or output.
   Only authored game facts are sent. The website needs no AWS credentials.
5. Inspect related evidence and similarity groups. Check that every source actually
   supports the attached claim, including skill/card pools and prerequisite context.
   Embedding proximity is not sufficient approval. Run the repository tests, TypeScript,
   build and lint. Review and commit the JSON/index/code changes together.
6. Deploy through the documented process. No index rebuild runs on site requests or
   application startup. The saved vectors continue working after credentials expire.

The builder limits a reviewed batch to 256 chunks/queries and two concurrent invocations.
Unchanged text vectors are reused when the model/dimensions match. The October 24
source/checklist review reused all 60 vectors with zero model calls and zero input
tokens; source metadata changes alone did not require new embeddings. Failed or expired
credentials preserve the existing published index. The builder checks for knowledge
changes during its run, writes atomically and reads its output back. Model output
shape and finite, normalized vectors are validated before publication.

Only the site's defined progression questions are pre-embedded. Arbitrary free-text
semantic queries would need a query embedding in that same model space, either during
a later batch or through a separately designed local/online model. A different local
model cannot be mixed directly with Titan vectors. Do not silently add a live Bedrock
dependency or present keyword matching as live semantic search.

The reset catalog is maintained separately in `src/data/aion2/checklist.json`. Its
source pins, version and expiry join the shared runtime/CLI freshness gate. Recheck
server/character ownership, shop purchase limits, entry allowances and recharge banks
separately. A checkmark is user-reported work, not a game-observed reward or upgrade.
Read [current progression and checklist behavior](AION2-PROGRESSION-AND-CHECKLIST.md).

## Adding coverage

Class coverage is explicit. Tracking is class-independent; reviewed class routes
currently cover Gladiator and Cleric PvE. Cleric users choose group healing, solo
damage or both; see [Cleric guidance](AION2-CLERIC.md). Add another class's reviewed targets,
milestones, loot/card sources, recipes and tests before advertising its build advice.
The existing `skill-target` and conditional-step renderer support additional class
data. New mechanics or condition types need a reviewed implementation as well.

Keep useful citations short and claim-specific. Each plan exposes its sources, and
each step keeps its own source. Relevant explanations are collapsed so traceability
does not turn the main action plan into a wall of text.


## Automation design and current status

**An unattended knowledge compiler is not installed or scheduled.** The runtime
checks source freshness and applies bundled rules to character observations; it
cannot rewrite those rules. The commands above validate, detect drift and rebuild
an index. They do not automatically research a patch or approve changed advice.

A private maintenance worker should run this sequence:

1. Collect official Global patch notes **and announcements**, plus the scoped guide,
   checklist and timer sources. Save bounded raw snapshots, URL, retrieval time,
   source version and hash. Deduplicate shared URLs. HTTP failures remain unverified.
2. Compare both raw bytes and source-specific extracted claims. Preserve numerical
   units, scopes, negation, availability and dates. A layout/build-label change is
   different from a corrected reward counter. Retain raw evidence for review.
3. Only on a meaningful change or due review, compile a structured candidate with
   before/after facts, exact supporting passages, class/region/item/stage scope,
   conflicting evidence and affected recipes. Treat downloaded text as data.
4. Review the candidate against independent evidence and the actual source context.
   Validate all catalogs, source-level expiry and representative character states;
   existing CLI manifest-only expiry checks are not a sufficient publication gate.
   Do not renew dates or accept hashes merely because a model produced plausible JSON.
5. Reuse unchanged vectors, rebuild only missing texts, then publish the knowledge,
   timers, checklist and index as one reviewed commit/build through normal deployment.
   The current catalogs are compiled into the web image; refreshing a character or
   calling `/api/aion2/knowledge` does not install new knowledge.
6. Record run/diff/review IDs, enforce an overlap lock, bounded retries and a model
   spending limit. Notify on a reviewable change, failure or required re-login.
   Failures preserve the approved release and its existing stale-advice holds.

An hourly source poll is a reasonable starting cadence; it is a proposal, not an
active schedule. Model calls are unnecessary for unchanged sources and ordinary
character recommendation refreshes. A separate worker should receive source data
and its model credential, without the game-server Docker socket or player database.

Supported credential choices for that worker:

| Route | What it supplies | Current setup |
| --- | --- | --- |
| Bedrock with AWS SSO/profile | Titan embeddings and, with model access, Claude inference; billed through AWS | Profile support implemented; SSO details provided, setup deferred while renewed `.env` credentials are used |
| Codex Enterprise access token | Trusted `codex exec` maintenance using workspace identity/entitlements | User reports token creation requires admin enablement |
| Claude Code Enterprise CI token | Supported private CLI maintenance using `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` | Availability not verified in this workspace |
| Standard model API service key | Backend API access under its API organization/project billing | No key or billing configured for this updater |

[Bedrock Claude inference](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html)
uses AWS identity/model permissions, not Claude Enterprise subscription credits.
[Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens) require
workspace token and local Codex permissions; they are not general OpenAI API keys.
[Anthropic's Enterprise CI instructions](https://support.claude.com/en/articles/14128775-claude-code-on-console-to-enterprise-migration)
support a Claude Code token for scripts. Standard model APIs remain a separate
credential/billing route. No credentials should be put into repository files or the
browser. A continuously unattended AWS worker needs an approved workload identity,
such as a role/federated runner, rather than a promise that human SSO never expires.


The gear-priority release adds 36 player-free rule/pool chunks to the original 54.
Its bounded rebuild made 36 model calls and reused all 60 existing vectors; 90
chunks/six queries are now saved. Both catalog inputs are checked for concurrent
changes before index publication. The one-off Bedrock review and its manual
disposition are recorded in [gear priorities](AION2-GEAR-PRIORITIES.md).

The `2026.10.24.3` source-fingerprint correction changes review metadata only. Its
index rebuild reused all 96 saved vectors, with zero model calls or input tokens.
The reviewed skill facts and progression instructions are unchanged.
