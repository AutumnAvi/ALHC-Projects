"use client";

// Icons for the rule builder's picker options and the sentence's tokens (Automations V2).

import {
  AlarmClock,
  ArrowRightLeft,
  AtSign,
  Bell,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  CircleDot,
  Clock,
  Columns3,
  Copy,
  FileInput,
  FilePlus2,
  FolderPlus,
  GitBranch,
  Hand,
  Hash,
  ListChecks,
  ListPlus,
  Mail,
  MessageSquare,
  Paperclip,
  PenLine,
  Repeat,
  RotateCcw,
  Send,
  MessagesSquare,
  Tag,
  Tags,
  ThumbsUp,
  Timer,
  Type,
  User,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SmartOption } from "@/components/smart-picker";

const ICONS: Record<string, LucideIcon> = {
  // Triggers
  task_created: FilePlus2,
  section_changed: Columns3,
  field_changed: PenLine,
  assignee_changed: UserCheck,
  due_approaching: CalendarClock,
  approval_decided: ThumbsUp,
  form_submitted: FileInput,
  inbound_received: Webhook,
  task_completed: CheckCircle2,
  task_reopened: RotateCcw,
  due_date_changed: CalendarClock,
  task_overdue: CalendarX,
  comment_added: MessageSquare,
  attachment_added: Paperclip,
  tag_added: Tag,
  subtasks_completed: ListChecks,
  task_added_from_project: FolderPlus,
  scheduled: Repeat,
  manual: Hand,
  // Conditions
  section_is: Columns3,
  section_is_not: Columns3,
  field_equals: PenLine,
  field_compare: Hash,
  field_is_set: PenLine,
  field_is_empty: PenLine,
  assignee_is_set: UserCheck,
  assignee_is_empty: UserMinus,
  assignee_is: User,
  assignee_is_not: User,
  creator_is: User,
  is_incomplete: CircleDot,
  is_complete: CheckCircle2,
  source_is: FileInput,
  has_tag: Tag,
  lacks_tag: Tag,
  is_overdue: CalendarX,
  due_within: CalendarClock,
  has_due_date: CalendarClock,
  no_due_date: CalendarClock,
  task_type_is: Type,
  has_open_subtasks: ListChecks,
  all_subtasks_done: ListChecks,
  title_contains: Type,
  form_answer_contains: FileInput,
  // Actions
  move_section: ArrowRightLeft,
  set_field: PenLine,
  set_assignee: UserPlus,
  add_comment: MessageSquare,
  add_followers: Users,
  notify: Bell,
  request_approval: ThumbsUp,
  send_email: Mail,
  send_slack: MessagesSquare,
  call_webhook: Webhook,
  delay: Timer,
  complete_task: CheckCircle2,
  reopen_task: RotateCcw,
  set_due_date: CalendarClock,
  add_tag: Tag,
  remove_tag: Tags,
  add_to_project: FolderPlus,
  create_subtasks: ListPlus,
  apply_task_template: Copy,
  // Misc
  branch: GitBranch,
  mention: AtSign,
  send: Send,
  wait: Clock,
  alarm: AlarmClock,
};

export function ruleIcon(value: string): LucideIcon {
  return ICONS[value] ?? Zap;
}

// A vocabulary item's icon as an element (a stable component, so it can be drawn during render).
export function RuleIcon({ value, className = "size-4" }: { value: string; className?: string }) {
  const Icon = ICONS[value] ?? Zap;
  return <Icon className={className} aria-hidden />;
}

// A vocabulary list (TRIGGERS, CONDITIONS, ACTIONS, …) as picker options with icons.
export function vocabOptions(
  list: readonly { value: string; label: string; group?: string; description?: string; keywords?: readonly string[] }[],
  opts: { icons?: boolean; disabled?: (value: string) => string | null } = {},
): SmartOption[] {
  return list.map((item) => {
    const Icon = ruleIcon(item.value);
    const reason = opts.disabled?.(item.value) ?? null;
    return {
      value: item.value,
      label: item.label,
      group: item.group,
      description: item.description,
      keywords: item.keywords,
      icon: opts.icons === false ? undefined : <Icon className="size-4" />,
      ...(reason ? { disabled: true, disabledReason: reason } : {}),
    };
  });
}
