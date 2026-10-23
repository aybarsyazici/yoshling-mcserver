# Reviewing and rebuilding Aion knowledge

The website applies reviewed rules to public character observations. Bedrock is a
build-time retrieval tool. It does not decide whether a claim is true, publish new
advice, or infer private game resources.

## What is saved

- `src/data/aion2/knowledge.json`: scoped sources, review/expiry dates, rules,
  milestones, activities, ordered recipes and Daevanion presets.
- `src/data/aion2/semantic-index.json`: normalized Titan embeddings of the authored
  game facts, pre-embedded progression questions, related evidence and similarity
  groups. It records the model, dimensions, knowledge digest and build statistics.
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
checks the exact knowledge digest, class applicability and currently applicable step
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
   the changes. Run:

   ```bash
   npm run aion2:knowledge:validate
   npm run aion2:knowledge:check
   npm run aion2:knowledge:embed
   ```

   The last command is a dry run and uses no credentials. It shows the bounded batch.
4. For changed text, refresh temporary AWS credentials locally in the gitignored
   `.env` using the existing `aws_access_key_id`, `aws_secret_access_key` and
   `aws_session_token` names, or use the normal AWS CLI credential provider. Run:

   ```bash
   npm run aion2:knowledge:embed -- --build --region us-west-2
   ```

   Only this explicit command reads AWS credentials. The build invokes the local AWS
   CLI, with credentials in its process environment rather than command arguments.
   It sends authored game knowledge only. It never prints credentials, account IDs,
   whole environments or raw AWS errors. The website does not need these credentials.
5. Inspect related evidence and similarity groups. Check that every source actually
   supports the attached claim, including skill/card pools and prerequisite context.
   Embedding proximity is not sufficient approval. Run the repository tests, TypeScript,
   build and lint. Review and commit the JSON/index/code changes together.
6. Deploy through the documented process. No index rebuild runs on site requests or
   application startup. The saved vectors continue working after credentials expire.

The builder limits a batch to 128 chunks/queries and two concurrent invocations.
Unchanged text vectors are reused when the model/dimensions match. Failed or expired
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

Class coverage is explicit. Tracking is class-independent; the first detailed skill
route and board preset are Gladiator PvE. Add another class's reviewed targets,
milestones, loot/card sources, recipes and tests before advertising its build advice.
The existing `skill-target` and conditional-step renderer support additional class
data. New mechanics or condition types need a reviewed implementation as well.

Keep useful citations short and claim-specific. Each plan exposes its sources, and
each step keeps its own source. Relevant explanations are collapsed so traceability
does not turn the main action plan into a wall of text.
