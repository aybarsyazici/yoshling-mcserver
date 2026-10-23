import { AION_NOTIFICATION_LATENESS_MS, aionNotificationSettingKey, DEFAULT_AION_NOTIFICATION_SETTING, validAionNotificationContext, validAionNotificationEvent, validAionNotificationSetting, type AionEventNotificationSetting, type AionNotificationAlert } from "./aion2-notifications";

export const AION_NOTIFICATION_STORAGE_KEY = "yoshling:aion2:notifications:v1";
const LOCK_NAME = "yoshling-aion2-notifications-v1";
const CHANGE_EVENT = "aion2-notification-preferences";
const RETENTION_MS = 7 * 86_400_000;
type Document = { version: 1; contexts: Record<string, { updatedAt: number; events: Record<string, AionEventNotificationSetting> }>; claims: Record<string, number> };
export type AionNotificationCoordination = "web-locks" | "indexeddb" | "unavailable";
export type AionNotificationPort = { transact<T>(work: (raw: unknown) => { value: T; document?: Document }): Promise<T>; close(): void };
export type AionNotificationStore = {
  mode: AionNotificationCoordination;
  load(context: string): Promise<Record<string, AionEventNotificationSetting>>;
  save(context: string, eventId: string, patch: Partial<AionEventNotificationSetting>): Promise<Record<string, AionEventNotificationSetting>>;
  claim(alert: AionNotificationAlert): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  close(): void;
};

function document(raw: unknown): Document {
  if (raw === null || raw === undefined) return { version: 1, contexts: {}, claims: {} };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(raw) || raw.version !== 1 || !object(raw.contexts) || !object(raw.claims) || Object.keys(raw.contexts).length > 64 || Object.keys(raw.claims).length > 2048) throw new Error("Saved alert data could not be verified. Alerts are disabled; repair or clear this browser's alert storage.");
  for (const [key, context] of Object.entries(raw.contexts)) {
    if (!validAionNotificationContext(key) || !object(context) || typeof context.updatedAt !== "number" || !Number.isFinite(context.updatedAt) || !object(context.events) || Object.keys(context.events).length > 40 || Object.entries(context.events).some(([id, setting]) => !validAionNotificationEvent(id) || !validAionNotificationSetting(setting))) throw new Error("Saved alert settings could not be verified; they were not overwritten.");
  }
  if (Object.entries(raw.claims).some(([key, until]) => key.length > 512 || typeof until !== "number" || !Number.isFinite(until))) throw new Error("Saved alert delivery records could not be verified.");
  return raw as Document;
}

/** Both browser adapters execute one atomic read-modify-write. Claim before delivery
 * gives at-most-once attempts; a crash between claim and display can miss an alert. */
export function aionNotificationStore(port: AionNotificationPort, mode: AionNotificationCoordination, changed: () => void = () => {}, subscribe: (listener: () => void) => () => void = () => () => {}): AionNotificationStore {
  return {
    mode,
    load: async (context) => {
      if (!validAionNotificationContext(context)) throw new Error("Choose a valid timer region and server.");
      return port.transact((raw) => ({ value: structuredClone(document(raw).contexts[context]?.events ?? {}) }));
    },
    save: async (context, eventId, patch) => {
      if (!validAionNotificationContext(context) || !validAionNotificationEvent(eventId) || !patch || Object.keys(patch).some((key) => !["enabled", "leadMinutes", "sound", "volume"].includes(key))) throw new Error("Invalid alert setting.");
      const value = await port.transact((raw) => {
        const doc = document(raw), previous = doc.contexts[context];
        const setting = { ...(previous?.events[eventId] ?? DEFAULT_AION_NOTIFICATION_SETTING), ...patch };
        if (!validAionNotificationSetting(setting)) throw new Error("Use a whole lead time from 0 to 180 minutes and volume from 0 to 100.");
        if (!previous && Object.keys(doc.contexts).length >= 64 || previous && !Object.hasOwn(previous.events, eventId) && Object.keys(previous.events).length >= 40) throw new Error("This browser's alert settings reached their storage limit.");
        doc.contexts[context] = { updatedAt: Date.now(), events: { ...previous?.events, [eventId]: setting } };
        return { value: structuredClone(doc.contexts[context].events), document: doc };
      });
      changed(); return value;
    },
    claim: (alert) => port.transact((raw) => {
      const doc = document(raw), now = Date.now();
      const setting = doc.contexts[alert.contextKey]?.events[alert.id];
      const alarm = Date.parse(alert.startsAt) - alert.setting.leadMinutes * 60_000;
      const expires = Date.parse(alert.verifiedUntil);
      const future = Date.parse(alert.startsAt) > now || alert.setting.leadMinutes === 0 && now - Date.parse(alert.startsAt) <= AION_NOTIFICATION_LATENESS_MS;
      if (!future || !Number.isFinite(alarm) || !Number.isFinite(expires) || !setting?.enabled || aionNotificationSettingKey(setting) !== aionNotificationSettingKey(alert.setting) || expires <= now || now < alarm || now - alarm > AION_NOTIFICATION_LATENESS_MS || doc.claims[alert.occurrenceKey] > now) return { value: false };
      for (const [key, until] of Object.entries(doc.claims)) if (until <= now) delete doc.claims[key];
      if (Object.keys(doc.claims).length >= 2048) throw new Error("This browser's recent alert records are full; duplicate alerts are withheld.");
      doc.claims[alert.occurrenceKey] = Math.max(now, Date.parse(alert.startsAt)) + RETENTION_MS;
      return { value: true, document: doc };
    }),
    subscribe, close: () => port.close(),
  };
}

function webLockPort(): AionNotificationPort {
  return {
    transact: (work) => navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, () => {
      const text = localStorage.getItem(AION_NOTIFICATION_STORAGE_KEY);
      if (text && text.length > 2_000_000) throw new Error("Saved alert data is too large to verify.");
      let raw: unknown = null;
      if (text !== null) { try { raw = JSON.parse(text); } catch { throw new Error("Saved alert data is unreadable; it was not overwritten."); } }
      const result = work(raw);
      if (result.document) {
        const encoded = JSON.stringify(result.document);
        localStorage.setItem(AION_NOTIFICATION_STORAGE_KEY, encoded);
        if (localStorage.getItem(AION_NOTIFICATION_STORAGE_KEY) !== encoded) throw new Error("Alert preferences could not be read back after saving.");
      }
      return result.value;
    }), close: () => {},
  };
}

/** Read/write transactions serialize claims across tabs when Web Locks is absent. */
function indexedPort(): Promise<AionNotificationPort> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const opening = indexedDB.open(AION_NOTIFICATION_STORAGE_KEY, 1);
    opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains("state")) opening.result.createObjectStore("state"); };
    opening.onerror = () => { failed = true; reject(new Error("Browser alert storage is unavailable.")); };
    opening.onblocked = () => { failed = true; reject(new Error("Another tab is blocking alert storage. Close it and retry.")); };
    opening.onsuccess = () => {
      const database = opening.result;
      if (failed) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve({
        transact: <T>(work: (raw: unknown) => { value: T; document?: Document }) => new Promise<T>((done, fail) => {
          const tx = database.transaction("state", "readwrite"), store = tx.objectStore("state");
          let value: T, failure: unknown;
          tx.oncomplete = () => done(value);
          tx.onerror = tx.onabort = () => fail(failure ?? new Error("Browser alert storage could not commit a verified update."));
          const read = store.get("document");
          read.onsuccess = () => {
            try {
              const result = work(read.result); value = result.value;
              if (result.document) {
                store.put(result.document, "document");
                const verify = store.get("document");
                verify.onsuccess = () => { if (JSON.stringify(verify.result) !== JSON.stringify(result.document)) { failure = new Error("Alert storage readback did not match."); tx.abort(); } };
              }
            } catch (error) { failure = error; tx.abort(); }
          };
        }), close: () => database.close(),
      });
    };
  });
}

export async function openAionNotificationStore(): Promise<AionNotificationStore> {
  let port: AionNotificationPort, mode: AionNotificationCoordination;
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") { port = webLockPort(); mode = "web-locks"; }
  else if (typeof indexedDB !== "undefined") { port = await indexedPort(); mode = "indexeddb"; }
  else throw new Error("This browser cannot coordinate event alerts safely across tabs. Alerts are disabled.");
  let channel: BroadcastChannel | null = null;
  try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(CHANGE_EVENT); } catch {}
  const changed = () => { window.dispatchEvent(new Event(CHANGE_EVENT)); channel?.postMessage("changed"); };
  const subscribe = (listener: () => void) => {
    const storage = (event: StorageEvent) => { if (event.key === AION_NOTIFICATION_STORAGE_KEY) listener(); };
    window.addEventListener(CHANGE_EVENT, listener); window.addEventListener("storage", storage); channel?.addEventListener("message", listener);
    return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener("storage", storage); channel?.removeEventListener("message", listener); };
  };
  const result = aionNotificationStore(port, mode, changed, subscribe), close = result.close;
  result.close = () => { channel?.close(); close(); };
  return result;
}
