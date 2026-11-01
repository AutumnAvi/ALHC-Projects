// Nov 1 notes, batch 10 (77): after a change someone makes, the app asks which automations it ran.
// useServerAction calls requestRuleFeedback() when a write finishes; the feedback layer in the app shell
// (components/rules/rule-feedback.tsx) listens, waits a moment so several writes are asked about once,
// and reads the person's own recent runs. Without a listener (public pages) nothing happens.

type Listener = (startedAt: number) => void;

const listeners = new Set<Listener>();

export function requestRuleFeedback(startedAt: number) {
  for (const listener of listeners) listener(startedAt);
}

export function onRuleFeedbackRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
