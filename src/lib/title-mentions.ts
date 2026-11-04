// Nov 4 notes (batch 27, 162): "@person" in a task's name. The name keeps the text as typed
// ("Remember to message @Dana Lee"), so emails, exports, search, and every plain-text place read "@Dana Lee";
// the app draws the part that names a workspace person as a chip linking to their profile. A mention in a
// name never assigns the task (and notifies nobody by itself). Pure, so the unit tests can pin it.

export type TitlePerson = { id: string; name: string; email?: string | null };

export type TitleSegment = { kind: "text"; text: string } | { kind: "person"; text: string; person: TitlePerson };

// The name a mention is written with: the person's name, else (no name, or a name that is an address)
// the part of their email before the @.
export function titleMentionHandle(person: Pick<TitlePerson, "name" | "email">): string {
  const name = person.name.trim();
  if (name && !name.includes("@")) return name;
  const email = (person.email ?? name).trim();
  return email.split("@")[0] || email;
}

const WORD = /[\p{L}\p{N}_]/u;

// Names a person can be mentioned by, longest-first matching happens below: the full name, the email's
// local part, and the first name when no one else in the list has that first name.
function namesOf(person: TitlePerson, firstNameCount: Map<string, number>): string[] {
  const names = [titleMentionHandle(person)];
  const full = person.name.trim();
  if (full && !full.includes("@") && !names.includes(full)) names.push(full);
  const local = person.email?.split("@")[0]?.trim();
  if (local) names.push(local);
  const first = full.includes("@") ? "" : full.split(/\s+/)[0];
  if (first && first !== full && firstNameCount.get(first.toLowerCase()) === 1) names.push(first);
  return names;
}

// The title cut into text and mentions of the given people. A mention is "@" at the start or after a
// space or an opening bracket, followed by one of the person's names (any case) that ends on a word
// boundary; the longest name wins. Unknown "@words" stay text.
export function titleMentionSegments(title: string, people: readonly TitlePerson[]): TitleSegment[] {
  if (!title.includes("@") || people.length === 0) return [{ kind: "text", text: title }];
  const firstNameCount = new Map<string, number>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first && !p.name.includes("@")) firstNameCount.set(first, (firstNameCount.get(first) ?? 0) + 1);
  }
  const candidates = people
    .flatMap((person) => namesOf(person, firstNameCount).map((name) => ({ person, name: name.toLowerCase() })))
    .filter((c) => c.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const lower = title.toLowerCase();
  const segments: TitleSegment[] = [];
  let from = 0;
  for (let at = title.indexOf("@"); at >= 0; at = title.indexOf("@", at + 1)) {
    if (at < from) continue;
    if (at > 0 && !/[\s([{"“‘]/.test(title[at - 1])) continue;
    const hit = candidates.find((c) => {
      if (!lower.startsWith(c.name, at + 1)) return false;
      const next = title[at + 1 + c.name.length];
      return next === undefined || !WORD.test(next);
    });
    if (!hit) continue;
    const end = at + 1 + hit.name.length;
    if (at > from) segments.push({ kind: "text", text: title.slice(from, at) });
    segments.push({ kind: "person", text: title.slice(at, end), person: hit.person });
    from = end;
    at = end - 1;
  }
  if (from < title.length) segments.push({ kind: "text", text: title.slice(from) });
  return segments.length ? segments : [{ kind: "text", text: title }];
}

export function titleHasMentions(title: string, people: readonly TitlePerson[]): boolean {
  return titleMentionSegments(title, people).some((s) => s.kind === "person");
}
