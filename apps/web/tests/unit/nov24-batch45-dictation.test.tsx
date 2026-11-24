// Batch 45 (item 3): built-in dictation. The support check decides whether the Talk button is drawn at all
// (Chrome / Edge / Safari yes, Firefox no, never on an insecure page), and insertDictated decides where the
// recognised words land in the box.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DictationBar, TalkButton } from "@/components/dictation-button";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { dictationErrorMessage, dictationSupport, formatElapsed, insertDictated, type Dictation } from "@/lib/dictation";

class FakeRecognition {}

test("dictationSupport: Chrome's prefixed API, the standard one, Firefox, and insecure pages", () => {
  assert.equal(dictationSupport({ isSecureContext: true, webkitSpeechRecognition: FakeRecognition }), FakeRecognition);
  assert.equal(dictationSupport({ isSecureContext: true, SpeechRecognition: FakeRecognition }), FakeRecognition);
  // The standard name wins when a browser has both.
  class Prefixed {}
  assert.equal(dictationSupport({ isSecureContext: true, SpeechRecognition: FakeRecognition, webkitSpeechRecognition: Prefixed }), FakeRecognition);
  // Firefox: no recognition API at all.
  assert.equal(dictationSupport({ isSecureContext: true, speechSynthesis: {} }), null);
  // An http page (not localhost): the browser would refuse the microphone.
  assert.equal(dictationSupport({ isSecureContext: false, webkitSpeechRecognition: FakeRecognition }), null);
  // Something that isn't a constructor, or no window at all (the server).
  assert.equal(dictationSupport({ isSecureContext: true, webkitSpeechRecognition: {} }), null);
  assert.equal(dictationSupport(undefined), null);
  assert.equal(dictationSupport(null), null);
});

test("insertDictated: words land at the cursor with spaces and sentence capitals", () => {
  // An empty box: a capital first letter, no spaces around.
  assert.deepEqual(insertDictated("", 0, 0, "move the send to wednesday"), { text: "Move the send to wednesday", caret: 26, from: 0 });
  // After a word: a space before; at the end nothing after.
  const after = insertDictated("Glen Oaks is first", 18, 18, "now thanks");
  assert.equal(after.text, "Glen Oaks is first now thanks");
  assert.equal(after.caret, after.text.length);
  // After a full stop: a new sentence (capital), one space.
  assert.equal(insertDictated("Done.", 5, 5, "next step is print").text, "Done. Next step is print");
  assert.equal(insertDictated("Done. ", 6, 6, "next").text, "Done. Next");
  // In the middle of text: a space after unless punctuation follows.
  const middle = insertDictated("Send it today.", 8, 8, "to Sarah");
  assert.equal(middle.text, "Send it to Sarah today.");
  assert.equal(middle.text.slice(middle.from, middle.caret), "to Sarah");
  assert.equal(insertDictated("Send it.", 7, 7, "now").text, "Send it now.");
  // A selection is replaced.
  assert.equal(insertDictated("Call Bob tomorrow", 5, 8, "Dana").text, "Call Dana tomorrow");
  // A new line starts a sentence.
  assert.equal(insertDictated("Notes:\n", 7, 7, "first item").text, "Notes:\nFirst item");
  // Punctuation the browser wrote doesn't get a space before it.
  assert.equal(insertDictated("Is it ready", 11, 11, "?").text, "Is it ready?");
  // Extra spaces in what was heard are tidied; nothing heard changes nothing.
  assert.equal(insertDictated("Hi", 2, 2, "  there   friend ").text, "Hi there friend");
  assert.deepEqual(insertDictated("Hi", 2, 2, "   "), { text: "Hi", caret: 2, from: 2 });
  // A cursor past the end is clamped.
  assert.equal(insertDictated("Hi", 99, 99, "there").text, "Hi there");
});

test("formatElapsed and error messages", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7.8), "0:07");
  assert.equal(formatElapsed(75), "1:15");
  assert.equal(dictationErrorMessage("aborted"), null);
  assert.equal(dictationErrorMessage("no-speech"), null);
  assert.match(dictationErrorMessage("not-allowed") ?? "", /Microphone access is blocked/);
  assert.ok(dictationErrorMessage("something-new"));
});

function fakeDictation(overrides: Partial<Dictation> = {}): Dictation {
  const noop = () => {};
  return {
    supported: true,
    listening: false,
    interim: "",
    at: null,
    elapsed: 0,
    error: null,
    start: noop,
    stop: noop,
    cancel: noop,
    abandon: noop,
    attach: () => noop,
    ...overrides,
  };
}

test("the Talk button: drawn only where dictation works; the listening row has Cancel and Stop", () => {
  assert.equal(renderToStaticMarkup(<TalkButton dictation={fakeDictation({ supported: false })} />), "");
  const idle = renderToStaticMarkup(<TalkButton dictation={fakeDictation()} label="Dictate a comment" />);
  assert.match(idle, /aria-label="Dictate a comment"/);
  assert.match(idle, />Talk</);
  const listening = renderToStaticMarkup(<TalkButton dictation={fakeDictation({ listening: true, elapsed: 7 })} />);
  assert.match(listening, /Listening… 0:07/);
  assert.match(listening, /Stop dictation/);
  const bar = renderToStaticMarkup(
    <DictationBar dictation={fakeDictation({ listening: true, elapsed: 3 })}>
      <button type="button">Comment</button>
    </DictationBar>,
  );
  assert.match(bar, /role="status"/);
  assert.match(bar, />Cancel</);
  assert.match(bar, />Stop</);
  assert.match(bar, />Comment</);
  assert.match(bar, /data-dictation-wave/);
  assert.equal(renderToStaticMarkup(<DictationBar dictation={fakeDictation()} />), "");
});

test("the comment box no longer offers Send for review (the review blocks do)", () => {
  const source = fs.readFileSync(new URL("../../src/components/task/task-activity.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Send for review…/);
  assert.doesNotMatch(source, /SendReviewDialog/);
  assert.match(source, /dictation=\{talk\}/);
});

test("the waveform and the recording dot stand still for reduced motion", () => {
  const css = fs.readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.dictation-wave-bar/);
  assert.match(reduced, /\.dictation-rec-dot/);
});

test("the comment box shows the words still being heard greyed at the cursor, and reports nothing yet", () => {
  const reported: string[] = [];
  const html = renderToStaticMarkup(
    <MentionTextarea
      value="Let’s move the send to"
      onValueChange={(v) => reported.push(v)}
      candidates={[]}
      aria-label="Comment"
      dictation={fakeDictation({ listening: true, interim: "wednesday morning at nine", at: 22 })}
    />,
  );
  // The box's value has the words in place; the layer draws them greyed.
  assert.match(html, /Let’s move the send to wednesday morning at nine<\/textarea>/);
  assert.match(html, /data-dictation-interim="" class="text-zinc-400">wednesday morning at nine</);
  // Nothing is saved until the words settle.
  assert.deepEqual(reported, []);
  // Not listening: the plain box, no layer.
  const idle = renderToStaticMarkup(
    <MentionTextarea value="Hello" onValueChange={() => {}} candidates={[]} aria-label="Comment" dictation={fakeDictation()} />,
  );
  assert.doesNotMatch(idle, /data-dictation-interim/);
});
