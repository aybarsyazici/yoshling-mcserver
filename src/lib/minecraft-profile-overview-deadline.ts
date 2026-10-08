/** A stalled fetch/body must not leave the overview panel permanently busy. */
export const OVERVIEW_UI_DEADLINE_MS = 15_000;
export async function withOverviewDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("The overview request timed out. Recheck its status before retrying.")); }, OVERVIEW_UI_DEADLINE_MS);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
