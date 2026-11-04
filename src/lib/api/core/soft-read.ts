// Nov 3 notes (batch 19, 142): a page's side panels (a count, a progress bar, a list of names) shouldn't
// take the whole page down when their read fails for a moment — the page renders without them and the
// failure is logged. Never use this for what the page is about, or for anything that decides access.
export async function softRead<T>(label: string, read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (error) {
    console.error(`[${label}] couldn't load: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}
