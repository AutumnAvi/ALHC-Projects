"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Mail } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { COMMENT_EMAIL_STATUS_LABELS, type CommentEmail } from "@/lib/comment-email";
import { mentionSegments, type MentionPerson } from "@/lib/mentions";

// Pieces of the comment feed (Comments and reply by email): @mention pills with a profile card on hover,
// and Asana's email cards for responses sent to a form's submitter and the submitter's emailed replies.

// What the hover card says under a person's email (e.g. "Editor"); null for nothing.
export type DescribePerson = (profileId: string) => string | null;

// A person's card: avatar, name, email, and their role here when known. Shown on hover / focus of a pill.
export function ProfileCard({ person, detail }: { person: MentionPerson; detail: string | null }) {
  const name = displayName(person);
  return (
    <div className="flex w-64 items-start gap-3 p-3" data-profile-card>
      <Avatar name={name} size="lg" />
      <div className="min-w-0 pt-0.5">
        <p className="truncate text-sm font-semibold text-zinc-900">{name}</p>
        <p className="truncate text-xs text-zinc-600">{person.email}</p>
        {detail ? <p className="mt-1 text-xs text-zinc-500">{detail}</p> : null}
      </div>
    </div>
  );
}

const CARD_WIDTH = 256;

// A highlighted @mention showing the person's real name. Hover or focus shows their card; a click does
// nothing (no navigation).
export function MentionPill({ person, detail, raw }: { person: MentionPerson; detail: string | null; raw: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const name = displayName(person);

  function show() {
    window.clearTimeout(hideTimer.current);
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 120 > window.innerHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8));
    setAnchor({ left, top: above ? rect.top - 6 : rect.bottom + 6, above });
  }
  function hide() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setAnchor(null), 80);
  }
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [anchor]);

  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        data-mention={person.id}
        title={raw === `@${name}` ? undefined : raw}
        aria-label={`@${name}, ${person.email}${detail ? `, ${detail}` : ""}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => e.preventDefault()}
        className="cursor-default rounded bg-accent-50 px-1 py-px font-medium text-accent-700 outline-none hover:bg-accent-100 focus-visible:ring-2 focus-visible:ring-accent-400"
      >
        @{name}
      </span>
      {anchor
        ? createPortal(
            <div
              role="tooltip"
              onMouseEnter={() => window.clearTimeout(hideTimer.current)}
              onMouseLeave={hide}
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                transform: anchor.above ? "translateY(-100%)" : undefined,
              }}
              className="z-[70] rounded-lg border border-zinc-200 bg-white shadow-lg"
            >
              <ProfileCard person={person} detail={detail} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// A comment or message body with its @mentions as pills. `people` = the people the database recorded as
// mentioned (others' "@words" stay plain text).
export function MentionText({
  body,
  people,
  describe,
}: {
  body: string;
  people: MentionPerson[];
  describe?: DescribePerson;
}) {
  const byId = new Map(people.map((p) => [p.id, p] as const));
  return (
    <>
      {mentionSegments(body, people).map((segment, index) =>
        segment.type === "text" ? (
          segment.text
        ) : (
          <MentionPill
            key={index}
            person={byId.get(segment.profileId)!}
            raw={segment.raw}
            detail={describe?.(segment.profileId) ?? null}
          />
        ),
      )}
    </>
  );
}

function EmailLink({ address }: { address: string }) {
  return (
    <a href={`mailto:${address}`} className="text-accent-700 hover:underline">
      {address}
    </a>
  );
}

// The mail-envelope avatar of a reply that came by email (the sender isn't a workspace person).
export function MailAvatar() {
  return (
    <span
      aria-hidden
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 text-zinc-500"
    >
      <Mail className="size-3.5" />
    </span>
  );
}

// Asana's email card: a rounded, bordered box with the subject in a light-gray header bar, the message,
// and the time (plus, for a response being sent, its delivery state) at the bottom.
export function EmailCard({
  email,
  createdAt,
  children,
}: {
  email: Pick<CommentEmail, "subject" | "status" | "error" | "direction">;
  createdAt: string;
  children: ReactNode;
}) {
  const status = email.direction === "sent" ? email.status : null;
  const problem = status === "failed" || status === "bounced";
  return (
    <div className="mt-1.5 overflow-hidden rounded-xl border border-zinc-200 bg-white" data-email-card={email.direction}>
      <div className="bg-zinc-100 px-3.5 py-2 text-sm font-semibold text-zinc-900">{email.subject}</div>
      <div className="whitespace-pre-wrap break-words px-3.5 pb-1 pt-2.5 text-sm leading-relaxed text-zinc-800">{children}</div>
      <div className="flex flex-wrap items-center gap-x-1 px-3.5 pb-2.5 pt-1 text-xs text-zinc-500">
        <Timestamp iso={createdAt} />
        {status ? (
          <span className={problem ? "text-red-600" : status === "delivered" ? "text-emerald-700" : undefined}>
            · {COMMENT_EMAIL_STATUS_LABELS[status]}
            {status === "failed" && email.error ? `: ${email.error.replace(/^Not sent: /, "")}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// The header of an email comment: who, when, and "Sent to <email>" / "Replied via <email>".
export function EmailCommentHeader({
  email,
  authorName,
  createdAt,
  actions,
}: {
  email: Pick<CommentEmail, "direction" | "address">;
  authorName: string;
  createdAt: string;
  actions?: ReactNode;
}) {
  const received = email.direction === "received";
  return (
    <>
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold text-zinc-900">{received ? email.address : authorName}</span>
        <span className="text-xs text-zinc-400" aria-hidden>
          ·
        </span>
        <Timestamp iso={createdAt} className="text-xs text-zinc-500" />
        {actions}
      </div>
      <p className="text-xs text-zinc-500">
        {received ? "Replied via " : "Sent to "}
        <EmailLink address={email.address} />
      </p>
    </>
  );
}
