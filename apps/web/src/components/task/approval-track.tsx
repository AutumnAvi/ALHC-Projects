"use client";

// Nov 24 batch 45: the task card's step track (docs/design/task-card/png/02, 04, 05, 07, 09). One look for
// the pane's pills (sequential: Work > Team > Outside > Done; parallel: Work splits into Team above Outside
// and they meet again at Done), the hover card with each step's facts, the wide view's vertical rail, and
// the role tags (blue "Team approver", amber "Outside reviewer") used wherever the two roles appear. The
// data is @alhc/core/approval-track's; this only draws it.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,

  GitFork,
  GitPullRequestArrow,
  Globe,
  Lock,
  Mail,
  MousePointerClick,
  RotateCcw,
  Send,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { ApprovalTrack, TrackRole, TrackStep } from "@alhc/core/approval-track";
import type { Profile } from "@alhc/core/api/people/model";
import { displayName } from "@alhc/core/people";
import { Avatar } from "@/components/avatar";
import { formatDueDate } from "@/lib/dates";
import { LAYER } from "@/lib/layers";

// --- Role colors: one source for every place the two roles appear ----------------------------------------

export const ROLE_TAG_CLASS = {
  team: "bg-[#dfe8f8] text-[#2a457f]",
  outside: "bg-amber-100 text-amber-800",
} as const;

export const ROLE_LABEL = { team: "Team approver", outside: "Outside reviewer" } as const;

export function RoleTag({ role, small = false, suffix }: { role: "team" | "outside"; small?: boolean; suffix?: string }) {
  const Icon = role === "team" ? Users : Globe;
  return (
    <span
      data-role-tag={role}
      className={`inline-flex shrink-0 items-center gap-1 rounded font-semibold tracking-[0.04em] whitespace-nowrap uppercase ${
        small ? "px-1.5 text-[10px] leading-4" : "px-[7px] py-px text-[11px] leading-[18px]"
      } ${ROLE_TAG_CLASS[role]}`}
    >
      {small ? null : <Icon className="size-3" aria-hidden />}
      {ROLE_LABEL[role]}
      {suffix ? <span className="normal-case">{suffix}</span> : null}
    </span>
  );
}

// --- Dates shown only in the browser (the viewer's zone; never a hydration mismatch) ----------------------

const noop = () => () => {};

export function LocalDateTime({ iso, withWeekday = false, timeOnly = false }: { iso: string; withWeekday?: boolean; timeOnly?: boolean }) {
  const ready = useSyncExternalStore(noop, () => true, () => false);
  if (!ready) return <time dateTime={iso} />;
  const d = new Date(iso);
  const text = timeOnly
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, {
        weekday: withWeekday ? "short" : undefined,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  return <time dateTime={iso}>{text}</time>;
}

// "Thu, Dec 11" for a YYYY-MM-DD date (no Date parsing of the zone: a calendar date stays the typed day).
export function weekdayDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${formatDueDate(value)}`;
}

// --- One pill ----------------------------------------------------------------------------------------------

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function OutsideAvatar({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[#c98a1b] font-medium text-white ${
        size === "sm" ? "size-5 text-[9px]" : "size-6 text-[10px]"
      }`}
    >
      {initials(name)}
    </span>
  );
}

function pillClass(step: TrackStep): string {
  const base =
    "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full text-[12.5px] whitespace-nowrap transition-shadow outline-none focus-visible:shadow-[0_0_0_4px_rgba(69,115,210,0.22)]";
  const tint = step.role === "outside" ? "outside" : step.role === "team" ? "team" : "plain";
  if (step.state === "done") return `${base} border border-zinc-300 bg-white pr-[11px] pl-[5px] text-zinc-700`;
  if (step.state === "current") {
    if (tint === "team") return `${base} border-2 border-accent-500 bg-[#f0f4fc] pr-2.5 pl-2 font-semibold text-[#233a68]`;
    if (tint === "outside") return `${base} border-2 border-amber-500 bg-amber-50 pr-2.5 pl-2 font-semibold text-amber-900`;
    return `${base} border-2 border-zinc-500 bg-white pr-2.5 pl-1.5 font-semibold text-zinc-800`;
  }
  if (step.state === "changes") return `${base} border border-amber-300 bg-amber-50 pr-2.5 pl-2 font-medium text-amber-900`;
  if (step.state === "rejected") return `${base} border border-red-300 bg-red-50 pr-2.5 pl-2 font-medium text-red-800`;
  return `${base} border border-dashed border-zinc-300 bg-white pr-[11px] pl-[11px] text-zinc-400`;
}

function PillContent({ step, profilesById }: { step: TrackStep; profilesById: Map<string, Profile> }) {
  const tint = step.role === "outside" ? "outside" : step.role === "team" ? "team" : "plain";
  const person = step.role === "work" && step.personIds[0] ? profilesById.get(step.personIds[0]) : undefined;
  const jump = step.role === "team" || step.role === "outside";
  return (
    <>
      {step.state === "done" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </span>
      ) : step.state === "current" ? (
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${
            tint === "team"
              ? "bg-accent-500 shadow-[0_0_0_3px_rgba(69,115,210,0.18)]"
              : tint === "outside"
                ? "bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.2)]"
                : "bg-zinc-600"
          }`}
        />
      ) : step.state === "changes" ? (
        <RotateCcw className="size-3.5 shrink-0" aria-hidden />
      ) : step.state === "rejected" ? (
        <X className="size-3.5 shrink-0" aria-hidden />
      ) : step.state === "locked" ? (
        <Lock className="size-3 shrink-0" aria-hidden />
      ) : null}
      {person ? <Avatar name={displayName(person)} src={person.avatar_url} profileId={person.id} /> : null}
      <span>{step.label}</span>
      {jump ? <ArrowDown className={`size-3 shrink-0 ${step.state === "waiting" || step.state === "locked" ? "opacity-50" : "opacity-75"}`} strokeWidth={2.5} aria-hidden /> : null}
    </>
  );
}

// --- The hover card ----------------------------------------------------------------------------------------

type HoverCardProps = {
  step: TrackStep;
  index: number;
  total: number;
  profilesById: Map<string, Profile>;
  modeLabel?: string | null;
  afterLabel?: string | null;
  jumpLabel?: string | null;
};

export function StepFacts({ step, profilesById, modeLabel, afterLabel, nameOf }: Omit<HoverCardProps, "index" | "total" | "jumpLabel"> & { nameOf?: (id: string) => string }) {
  const name = (id: string) => nameOf?.(id) ?? (profilesById.get(id) ? displayName(profilesById.get(id)!) : "Someone");
  const rows: { icon: ReactNode; text: ReactNode; key: string }[] = [];
  const due = step.dueOn;
  if (step.role === "team" && due) rows.push({ key: "due", icon: <CalendarDays className="size-3.5" />, text: <>Approval due <b className="font-medium text-zinc-800">{weekdayDate(due)}</b></> });
  if (step.role === "outside" && due) rows.push({ key: "due", icon: <CalendarDays className="size-3.5" />, text: <>Due <b className="font-medium text-zinc-800">{weekdayDate(due)}</b></> });
  if (step.sentAt && step.role !== "done") {
    rows.push({
      key: "sent",
      icon: <Send className="size-3.5" />,
      text: (
        <>
          {step.role === "work" ? "Sent for approval" : step.sentBy ? `Sent by ${name(step.sentBy)}` : "Sent"} · <LocalDateTime iso={step.sentAt} withWeekday />
        </>
      ),
    });
  }
  if (step.round !== null && step.role !== "work") {
    const prev = step.previous;
    rows.push({
      key: "round",
      icon: <RotateCcw className="size-3.5" />,
      text: (
        <>
          Round {step.round}
          {prev && step.role === "team"
            ? ` · round ${prev.number} ${prev.status === "rejected" ? "rejected" : prev.status === "withdrawn" ? "withdrawn" : "changes requested"}${prev.at ? ` ${formatDueDate(prev.at.slice(0, 10))}` : ""}`
            : ""}
        </>
      ),
    });
  }
  if (step.reminderOn) {
    rows.push({
      key: "reminder",
      icon: <Bell className="size-3.5" />,
      text: step.reminderSent ? `Reminder went out ${weekdayDate(step.reminderOn)}` : `Reminder goes out ${weekdayDate(step.reminderOn)}`,
    });
  }
  if (step.role === "outside" && step.state === "locked") rows.push({ key: "lock", icon: <Lock className="size-3.5" />, text: "Starts when the team approves" });
  if (step.role === "outside") rows.push({ key: "mail", icon: <Mail className="size-3.5" />, text: "Email link, no login" });
  if (step.role === "done" && afterLabel) rows.push({ key: "after", icon: <Zap className="size-3.5" />, text: afterLabel });
  return (
    <>
      {step.role === "team" && step.personIds.length ? (
        <div className="space-y-1.5">
          {step.personIds.map((id) => {
            const p = profilesById.get(id);
            return (
              <div key={id} className="flex items-center gap-2">
                <Avatar name={name(id)} src={p?.avatar_url} profileId={id} size="md" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-zinc-900">{name(id)}</span>
                  {modeLabel && id === step.personIds[0] ? <span className="block text-xs text-zinc-500">{modeLabel}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {step.role === "outside" && step.outside ? (
        <div className="flex items-center gap-2">
          <OutsideAvatar name={step.outside.name ?? step.outside.email} size="md" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-zinc-900">{step.outside.name ?? step.outside.email}</span>
            <span className="block truncate text-xs text-zinc-500">{step.outside.email}</span>
          </span>
        </div>
      ) : null}
      {step.role === "work" && step.personIds[0] ? (
        <div className="flex items-center gap-2">
          <Avatar name={name(step.personIds[0])} src={profilesById.get(step.personIds[0])?.avatar_url} profileId={step.personIds[0]} size="md" />
          <span className="text-sm font-semibold text-zinc-900">{name(step.personIds[0])}</span>
        </div>
      ) : null}
      <p className="mt-2 text-xs font-medium text-zinc-700">{step.status}</p>
      {rows.length ? (
        <ul className="mt-2 space-y-1.5 border-t border-zinc-100 pt-2 text-[13px] text-zinc-600">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-zinc-400" aria-hidden>
                {r.icon}
              </span>
              <span className="min-w-0">{r.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function HoverCard(props: HoverCardProps & { anchor: HTMLElement; id: string; onEnter: () => void; onLeave: () => void }) {
  const { step, index, total, anchor, jumpLabel } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const card = ref.current?.getBoundingClientRect();
      const width = card?.width ?? 320;
      const height = card?.height ?? 220;
      let left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      let top = r.bottom + 8;
      if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 8);
      left = Math.max(8, left);
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  const role = step.role === "team" || step.role === "outside" ? step.role : null;
  return createPortal(
    <div
      ref={ref}
      id={props.id}
      role="tooltip"
      data-track-hover={step.role}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className={`ui-anim-pop-in fixed ${LAYER.floating} w-80 max-w-[calc(100vw-16px)] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        {role ? <RoleTag role={role} /> : <span className="text-xs font-semibold text-zinc-800">{step.label}</span>}
        <span className="text-xs text-zinc-500">
          Step {index + 1} of {total}
        </span>
      </div>
      <StepFacts step={step} profilesById={props.profilesById} modeLabel={props.modeLabel} afterLabel={props.afterLabel} />
      {jumpLabel ? (
        <p className="mt-2 flex items-center gap-1.5 border-t border-zinc-100 pt-2 text-xs font-medium text-accent-700">
          <MousePointerClick className="size-3.5" aria-hidden />
          {jumpLabel}
        </p>
      ) : null}
    </div>,
    document.body,
  );
}

function Pill({
  step,
  index,
  total,
  profilesById,
  onStep,
  modeLabel,
  afterLabel,
  jumpLabel,
}: HoverCardProps & { onStep?: (role: TrackRole) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const cardId = useId();
  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 150);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const clickable = Boolean(onStep);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        data-track-pill={step.role}
        data-track-state={step.state}
        aria-describedby={open ? cardId : undefined}
        aria-label={`${step.label}: ${step.status}${clickable ? ". Go to it" : ""}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onClick={() => {
          setOpen(false);
          onStep?.(step.role);
        }}
        className={`${pillClass(step)} ${clickable ? "cursor-pointer hover:shadow-[0_0_0_4px_rgba(69,115,210,0.22)]" : "cursor-default"}`}
      >
        <PillContent step={step} profilesById={profilesById} />
      </button>
      {open && anchor ? (
        <HoverCard
          id={cardId}
          anchor={anchor}
          step={step}
          index={index}
          total={total}
          profilesById={profilesById}
          modeLabel={modeLabel}
          afterLabel={afterLabel}
          jumpLabel={jumpLabel}
          onEnter={show}
          onLeave={hide}
        />
      ) : null}
    </>
  );
}

// --- The pills ---------------------------------------------------------------------------------------------

function Fork({ join = false }: { join?: boolean }) {
  return (
    <svg width="26" height="72" viewBox="0 0 26 72" aria-hidden className="shrink-0 text-zinc-400">
      <path
        d={join ? "M0 16 C13 16 13 36 26 36 M0 56 C13 56 13 36 26 36" : "M0 36 C13 36 13 16 26 16 M0 36 C13 36 13 56 26 56"}
        stroke="currentColor"
        strokeWidth={1.6}
        fill="none"
      />
    </svg>
  );
}

const Sep = () => <ChevronRight className="size-3.5 shrink-0 text-zinc-400" aria-hidden />;

export type TrackExtras = {
  modeLabel?: string | null;
  afterLabel?: string | null;
  // "Click to jump to Avi’s block" per role (null = no hint).
  jumpLabel?: (step: TrackStep) => string | null;
};

// The approval setup's live preview (mockup 08): the plan's pills, tinted by role, not interactive.
const PLAN_PILL =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-[11px] text-[12.5px] whitespace-nowrap";
const PLAN_TINT: Record<TrackRole, string> = {
  work: "border-zinc-300 bg-white pl-[5px] text-zinc-700",
  team: "border-[#96b2e6] bg-[#f0f4fc] font-medium text-[#233a68]",
  outside: "border-[#fcd34d] bg-amber-50 font-medium text-amber-900",
  done: "border-zinc-300 bg-white text-zinc-700",
};

function PlanPill({ step, profilesById }: { step: TrackStep; profilesById: Map<string, Profile> }) {
  const person = step.role === "work" && step.personIds[0] ? profilesById.get(step.personIds[0]) : undefined;
  return (
    <span data-plan-pill={step.role} className={`${PLAN_PILL} ${PLAN_TINT[step.role]} ${!person && step.role === "work" ? "pl-[11px]" : ""}`}>
      {person ? <Avatar name={displayName(person)} src={person.avatar_url} profileId={person.id} /> : null}
      <span>{step.label}</span>
    </span>
  );
}

export function TrackPills({
  track,
  profiles,
  onStep,
  extras = {},
  variant = "track",
}: {
  track: Pick<ApprovalTrack, "steps" | "order">;
  profiles: Profile[];
  onStep?: (role: TrackRole) => void;
  extras?: TrackExtras;
  // "plan": the setup's live preview (tinted, static).
  variant?: "track" | "plan";
}) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const total = track.steps.length;
  const pill = (step: TrackStep, index: number) =>
    variant === "plan" ? (
      <PlanPill key={step.role} step={step} profilesById={profilesById} />
    ) : (
    <Pill
      key={step.role}
      step={step}
      index={index}
      total={total}
      profilesById={profilesById}
      onStep={onStep}
      modeLabel={step.role === "team" ? extras.modeLabel : null}
      afterLabel={step.role === "done" ? extras.afterLabel : null}
      jumpLabel={onStep ? (extras.jumpLabel?.(step) ?? null) : null}
    />
  );
  const team = track.steps.findIndex((s) => s.role === "team");
  const outside = track.steps.findIndex((s) => s.role === "outside");
  if (track.order === "parallel" && team >= 0 && outside >= 0) {
    const work = track.steps.findIndex((s) => s.role === "work");
    const done = track.steps.findIndex((s) => s.role === "done");
    return (
      <div className="flex min-w-0 flex-nowrap items-center overflow-x-auto" data-track-row="parallel">
        {pill(track.steps[work], work)}
        <Fork />
        <span className="flex flex-col gap-2">
          {pill(track.steps[team], team)}
          {pill(track.steps[outside], outside)}
        </span>
        <Fork join />
        {pill(track.steps[done], done)}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-track-row="sequential">
      {track.steps.map((step, i) => (
        <span key={step.role} className="inline-flex items-center gap-1">
          {i > 0 ? <Sep /> : null}
          {pill(step, i)}
        </span>
      ))}
    </div>
  );
}

// The pane's track card (pinned at the top of the card, above the tabs).
export function ApprovalTrackCard({
  track,
  profiles,
  onStep,
  extras,
}: {
  track: ApprovalTrack;
  profiles: Profile[];
  onStep?: (role: TrackRole) => void;
  extras?: TrackExtras;
}) {
  const Icon = track.kind === "outside" ? Globe : track.order === "parallel" ? GitFork : GitPullRequestArrow;
  return (
    <section
      aria-label={track.kind === "outside" ? "Outside review steps" : "Approval steps"}
      data-approval-track={track.order}
      className="mt-3 mb-1 rounded-[10px] border border-zinc-200 bg-zinc-50/70 px-3 pt-2 pb-2.5"
    >
      <p className="mb-[7px] flex items-center gap-1.5 text-[11px] leading-4 font-medium tracking-[0.01em] text-zinc-500">
        <Icon className="size-3" aria-hidden />
        {track.headline}
      </p>
      <TrackPills track={track} profiles={profiles} onStep={onStep} extras={extras} />
    </section>
  );
}

// --- The wide view's rail ----------------------------------------------------------------------------------

function RailDot({ step }: { step: TrackStep }) {
  if (step.state === "done") {
    return (
      <span className="relative z-[1] inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
        <Check className="size-4" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (step.state === "current") {
    const color = step.role === "outside" ? "border-amber-500 text-amber-500" : step.role === "team" ? "border-accent-500 text-accent-500" : "border-zinc-500 text-zinc-500";
    return (
      <span className={`relative z-[1] inline-flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-white ${color}`}>
        <span className="size-3 rounded-full bg-current" />
      </span>
    );
  }
  const color = step.role === "outside" ? "border-amber-400" : step.state === "changes" ? "border-amber-400" : step.state === "rejected" ? "border-red-400" : "border-zinc-300";
  return <span className={`relative z-[1] inline-flex size-7 shrink-0 rounded-full border-2 border-dashed bg-white ${color}`} />;
}

export function TrackRail({
  track,
  profiles,
  onStep,
  extras = {},
}: {
  track: ApprovalTrack;
  profiles: Profile[];
  onStep?: (role: TrackRole) => void;
  extras?: TrackExtras;
}) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const sub = track.headline.replace(/^Approval · |^Outside review · /, "");
  const label = (s: TrackStep) =>
    s.role === "work" ? "Work" : s.role === "team" ? ROLE_LABEL.team : s.role === "outside" ? ROLE_LABEL.outside : "Done";
  return (
    <nav aria-label="Approval path" data-track-rail="">
      <p className="flex items-center gap-1.5 text-[15px] font-semibold text-zinc-900">
        <GitPullRequestArrow className="size-4" aria-hidden />
        {track.kind === "outside" ? "Outside review" : "Approval path"}
      </p>
      <p className="mt-0.5 text-[13px] text-zinc-500 first-letter:uppercase">{sub}</p>
      <ol className="relative mt-4">
        {track.steps.map((s, i) => (
          <li key={s.role} className="relative flex gap-3 pb-5 last:pb-0">
            {i < track.steps.length - 1 ? (
              <span aria-hidden className={`absolute top-7 bottom-0 left-[13px] w-0.5 ${s.state === "done" ? "bg-green-300" : "bg-zinc-200"}`} />
            ) : null}
            <RailDot step={s} />
            <div className="min-w-0 flex-1 pt-0.5">
              <button
                type="button"
                onClick={() => onStep?.(s.role)}
                className={`text-left text-[15px] font-semibold ${
                  s.state === "current" ? (s.role === "outside" ? "text-amber-800" : "text-accent-700") : s.state === "waiting" || s.state === "locked" ? "text-zinc-500" : "text-zinc-900"
                } ${onStep ? "hover:underline" : "cursor-default"}`}
              >
                {label(s)}
              </button>
              <div className="mt-1 text-[13px] text-zinc-600">
                <StepFacts step={s} profilesById={profilesById} modeLabel={s.role === "team" ? extras.modeLabel : null} afterLabel={s.role === "done" ? extras.afterLabel : null} />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// The step's color word for screen readers and tests.
export function stepTone(step: TrackStep): "blue" | "amber" | "green" | "grey" | "red" {
  if (step.state === "done") return "green";
  if (step.state === "rejected") return "red";
  if (step.role === "outside" || step.state === "changes") return "amber";
  if (step.role === "team" && step.state === "current") return "blue";
  return "grey";
}

