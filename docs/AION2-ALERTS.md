# Timer alerts

Each event has an **Alerts** control. Preferences are saved in this browser for the
selected region/server and event. Alerts default off. Choose 5, 10, 15 or a custom
0–180 minute lead, Chime/Bell/Pulse/Silent, and volume. **Preview sound** creates or
resumes browser audio from that click. **Enable desktop notifications** separately
requests the browser's permission from a click. Neither request happens on load.

## Delivery limits

The helper must remain open. Hidden tabs can be throttled, frozen or discarded, and
device sleep can stop timers. This implementation has no service worker, push
subscription or closed-app scheduling. Desktop notifications can be denied or
unsupported while in-page reminders and activated audio remain available. Custom
tones use Web Audio; they are not portable operating-system notification sounds.
Browser audio may require activation again after reload or interruption.

Primary browser references:

- [Notifications permissions and desktop/mobile constructors](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)
- [Web Audio activation and controls](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
- [Page lifecycle: frozen and discarded pages](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

## Scheduling and source status

The planner uses absolute event starts, including enough future occurrences for a
long warning on an hourly event. Entry/play-window ends are not notification targets.
Zero-minute warnings require a prior arm and a bounded start-boundary allowance.
Loading settings, enabling an already-passed warning, resuming after a long pause or
changing a lead does not replay old alerts. A delayed known alarm can be attempted
within 90 seconds while the clock remains continuous within 180 seconds. Positive
lead reminders for events already started are discarded.

All targets carry a verification deadline. The source status must be current and
checked within 30 minutes, including the timer's own review expiry. While any alert
is enabled, the client reads authenticated `/api/aion2/knowledge` every five minutes,
including while hidden. That route requests the shared source check at a maximum
15-minute age, with a five-minute minimum interval and shared inflight deduplication.
It reads no character roster. Source request failures pause alerts; expiry, region
changes and component cleanup revoke old targets.

Gartua alerts require a fresh report for the selected server and a kill-dependent
estimate. They retain community attribution and never establish boss liveness or
invent another cycle after an estimate elapses. Changed pending estimates are
rescheduled. The occurrence identity uses the server and reported kill so one
reported cycle cannot repeatedly alert as its estimate changes.

## Persistence and coordination

Preferences and recent attempted occurrences use local browser storage. Web Locks
serializes localStorage reads/writes when available; an atomic IndexedDB transaction
is the fallback. Without either coordinator, alerts are disabled. Writes are read
back before the UI confirms them. Cross-tab change events refresh settings; unknown
or malformed saved data is not silently overwritten. Storage errors are visible.

An occurrence is claimed before sound/desktop delivery, providing at-most-once
attempts across tabs and reloads. The claim is bounded and retained seven days after
the occurrence. A crash or browser denial after the claim can miss delivery. Context,
settings, source deadline, event time and component lifetime are checked again after
the asynchronous claim. Disabling an event or changing server cancels old delivery.
The settings store is local to the origin/browser, not synchronized to Discord or
NCSOFT accounts. It stores no game credentials and makes no AWS call.

## Copy

The helper uses functional labels: **Track your progress**, **Add a character**,
**Daily & weekly checklist**, **Daevanion board** and **Activity guide**. Motivational
taglines were removed. Deployment verification uses the actual current title literal.

## Verification

Domain, storage, runtime and UI tests cover source/identity checks, long/zero leads,
bounded delays, changed estimates, permission/audio gestures, settings readback,
cross-tab claims and asynchronous cancellation. Mutation proofs and final repository
checks are recorded with the change. Local preview settings use the browser's real
storage; its captured character/checklist fixture is still a preview, not deployment.

Final local verification on 2026-10-23: 209 test files / 3,759 tests passed; TypeScript,
normal build and lint passed. Build/lint retained thirteen/seven existing warnings.
The full suite passed running alone after one unchanged Minecraft disk-budget test
timed out during a parallel build run; its timeout/test was not changed. Notification
guard mutations were restored and proved green. Actual OS delivery, audible hardware
output, mobile and sleeping-device behavior are not established by offline tests.
The web deployment completed on 2026-10-23; see the
[rollout record](AION2-DEPLOYMENT.md). Production sign-in and actual OS notification
delivery remain unverified.

In-app browser preview check: the headline is functional; 15 minutes / Bell / 5%
were saved and verified after reload. Preview sound activated the AudioContext for
that session. The test preference was restored to off / 10 minutes / Chime / 60%.
No desktop permission prompt was requested. The settings view fits 390px without
horizontal page overflow. This verifies UI/storage/audio activation, not OS delivery.
