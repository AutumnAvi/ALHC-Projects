"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileText, Mail, Paperclip, UsersRound } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { ImageLightbox } from "./task-attachments";
import { previewKind } from "@/lib/attachment-preview";
import { COMMENT_EMAIL_STATUS_LABELS, type CommentEmail } from "@/lib/comment-email";
import { mentionSegments, type MentionPerson, type MentionTeam } from "@/lib/mentions";

// Pieces of the comment feed (Comments and reply by email): @mention pills with a profile card on hover,
// and Asana's email cards for responses sent to a form's submitter and the submitter's emailed replies.

// What the hover card says under a person's email (e.g. "Editor"); null for nothing.
export type DescribePerson = (profileId: string) => string | null;

// A person's card: avatar, name, email, and their role here when known. Shown on hover / focus of a pill.
export function ProfileCard({ person, detail }: { person: MentionPerson; detail: string | null }) {
  const name = displayName(person);
  return (
    <div className="flex w-64 items-start gap-3 p-3" data-profile-card>
      <Avatar name={name} profileId={person.id} size="lg" />
      <div className="min-w-0 pt-0.5">
        <p className="truncate text-sm font-semibold text-zinc-900">{name}</p>
        <p className="truncate text-xs text-zinc-600">{person.email}</p>
        {detail ? <p className="mt-1 text-xs text-zinc-500">{detail}</p> : null}
      </div>
    </div>
  );
}

const CARD_WIDTH = 256;

// A highlighted pill with a card on hover or focus; a click does nothing (no navigation). Shared by
// person and team mentions.
function HoverPill({
  label,
  title,
  ariaLabel,
  data,
  card,
}: {
  label: string;
  title?: string;
  ariaLabel: string;
  data: Record<string, string>;
  card: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  function show() {
    window.clearTimeout(hideTimer.current);
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 160 > window.innerHeight;
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
        {...data}
        title={title}
        aria-label={ariaLabel}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => e.preventDefault()}
        className="cursor-default rounded bg-accent-50 px-1 py-px font-medium text-accent-700 outline-none hover:bg-accent-100 focus-visible:ring-2 focus-visible:ring-accent-400"
      >
        {label}
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
              {card}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// A highlighted @mention showing the person's real name. Hover or focus shows their card; a click does
// nothing (no navigation).
export function MentionPill({ person, detail, raw }: { person: MentionPerson; detail: string | null; raw: string }) {
  const name = displayName(person);
  return (
    <HoverPill
      label={`@${name}`}
      title={raw === `@${name}` ? undefined : raw}
      ariaLabel={`@${name}, ${person.email}${detail ? `, ${detail}` : ""}`}
      data={{ "data-mention": person.id }}
      card={<ProfileCard person={person} detail={detail} />}
    />
  );
}

const TEAM_CARD_MEMBERS = 8;

// A team's card: its name and members (the first eight, then a count). Like a person's card, nothing
// to click.
export function TeamCard({ team }: { team: MentionTeam }) {
  const shown = team.members.slice(0, TEAM_CARD_MEMBERS);
  return (
    <div className="w-64 p-3" data-team-card>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">
          <UsersRound className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-900">{team.name}</p>
          <p className="text-xs text-zinc-500">
            {team.members.length} member{team.members.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      {shown.length ? (
        <ul className="mt-2.5 space-y-1.5">
          {shown.map((m) => (
            <li key={m.id} className="flex items-center gap-2">
              <Avatar name={m.name} profileId={m.id} size="sm" />
              <span className="min-w-0 truncate text-xs text-zinc-700">{m.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {team.members.length > shown.length ? (
        <p className="mt-1.5 text-xs text-zinc-500">and {team.members.length - shown.length} more</p>
      ) : null}
    </div>
  );
}

// A highlighted @team mention: the team's name; hover or focus shows its members.
export function TeamMentionPill({ team, raw }: { team: MentionTeam; raw: string }) {
  return (
    <HoverPill
      label={`@${team.name}`}
      title={raw === `@${team.name}` ? undefined : raw}
      ariaLabel={`@${team.name}, team of ${team.members.length}`}
      data={{ "data-team-mention": team.id }}
      card={<TeamCard team={team} />}
    />
  );
}

// A comment or message body with its @mentions as pills. `people` = the people the database recorded as
// mentioned (others' "@words" stay plain text).
export function MentionText({
  body,
  people,
  describe,
  teams = [],
}: {
  body: string;
  people: MentionPerson[];
  describe?: DescribePerson;
  // Teams whose @name shows as a pill with its members (display only).
  teams?: MentionTeam[];
}) {
  const byId = new Map(people.map((p) => [p.id, p] as const));
  const teamsById = new Map(teams.map((t) => [t.id, t] as const));
  return (
    <>
      {mentionSegments(body, people, teams).map((segment, index) =>
        segment.type === "text" ? (
          segment.text
        ) : segment.type === "team" ? (
          <TeamMentionPill key={index} team={teamsById.get(segment.teamId)!} raw={segment.raw} />
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
  files,
}: {
  email: Pick<CommentEmail, "subject" | "status" | "error" | "direction">;
  createdAt: string;
  children: ReactNode;
  // A received reply's attachments (EmailFiles), under the message.
  files?: ReactNode;
}) {
  const status = email.direction === "sent" ? email.status : null;
  const problem = status === "failed" || status === "bounced";
  return (
    <div className="mt-1.5 overflow-hidden rounded-xl border border-zinc-200 bg-white" data-email-card={email.direction}>
      <div className="bg-zinc-100 px-3.5 py-2 text-sm font-semibold text-zinc-900">{email.subject}</div>
      <div className="whitespace-pre-wrap break-words px-3.5 pb-1 pt-2.5 text-sm leading-relaxed text-zinc-800">{children}</div>
      {files}
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

// A reply's image at its own shape, at most 20rem tall (a failed load falls back to a file chip).
function InlineImage({ src, alt, onBroken }: { src: string; alt: string; onBroken: () => void }) {
  const ref = useRef<HTMLImageElement>(null);
  const brokenRef = useRef(onBroken);
  useEffect(() => {
    brokenRef.current = onBroken;
  }, [onBroken]);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) brokenRef.current();
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- auth-gated redirect to a short-lived signed URL; next/image can't optimise it
    <img ref={ref} src={src} alt={alt} loading="lazy" decoding="async" onError={onBroken} className="mx-auto max-h-80 w-auto max-w-full object-contain" />
  );
}

const SKIP_REASONS = {
  too_large: "over 25 MB",
  too_many: "more than 10 files",
  failed: "couldn’t be saved",
  blocked_type: "this kind of file isn’t saved from email",
} as const;

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The files that came with a submitter's emailed reply (saved to the task) and the ones that weren't,
// with why. Shown inside the reply's email card: images inline that open in the lightbox, PDFs
// in the browser's viewer, the rest as downloads (the same rule as the pane's Attachments, previewKind).
export function EmailFiles({
  files,
  skipped,
}: {
  files: { id: string; name: string; sizeBytes: number; contentType?: string | null }[];
  skipped: { name: string; reason: keyof typeof SKIP_REASONS }[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  if (!files.length && !skipped.length) return null;
  const kinds = files.map((file) => previewKind(file.name, file.contentType ?? null));
  const images = files.filter((file, i) => kinds[i] === "image" && !broken.has(file.id));
  const others = files.filter((file, i) => kinds[i] !== "image" || broken.has(file.id));
  const openImage = open === null ? null : (images[open] ?? null);
  return (
    <div className="border-t border-zinc-100 px-3.5 py-2" data-email-files>
      {images.length ? (
        // Oct 26 notes (batch 3): the reply's images show inline at a readable size (like in the email);
        // a click opens them full size in the lightbox.
        <ul className={`mb-1.5 grid gap-1.5 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`} aria-label="Images">
          {images.map((file, i) => (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => setOpen(i)}
                aria-label={`View ${file.name} full size`}
                data-tooltip={file.name}
                className="block w-full overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 hover:border-zinc-300 focus-visible:outline-2 focus-visible:outline-accent-500"
              >
                <InlineImage
                  src={`/attachments/${file.id}?preview=1`}
                  alt={file.name}
                  onBroken={() => setBroken((current) => new Set(current).add(file.id))}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
          {others.map((file) => {
            const pdf = previewKind(file.name, file.contentType ?? null) === "pdf";
            return (
              <li key={file.id}>
                <a
                  href={pdf ? `/attachments/${file.id}?preview=1` : `/attachments/${file.id}`}
                  target={pdf ? "_blank" : undefined}
                  rel={pdf ? "noopener" : undefined}
                  className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                >
                  {pdf ? (
                    <FileText className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                  ) : (
                    <Paperclip className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                  )}
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-zinc-400">{fileSize(file.sizeBytes)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
      {skipped.length ? (
        <p className={`text-xs text-amber-800 ${files.length ? "mt-1.5" : ""}`}>
          Not saved: {skipped.map((f) => `${f.name} (${SKIP_REASONS[f.reason]})`).join(", ")}
        </p>
      ) : null}
      {openImage && open !== null ? (
        <ImageLightbox
          image={{ id: openImage.id, fileName: openImage.name }}
          position={open + 1}
          total={images.length}
          onPrevious={() => setOpen((i) => (i === null ? i : (i - 1 + images.length) % images.length))}
          onNext={() => setOpen((i) => (i === null ? i : (i + 1) % images.length))}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
