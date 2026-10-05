"use client";

import { useSyncExternalStore } from "react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Due dates are calendar dates (YYYY-MM-DD) with no timezone; format them without Date parsing so
// server and client render identically.
export function formatDueDate(value: string, currentYear?: number) {
  const [year, month, day] = value.split("-").map(Number);
  const label = `${MONTHS[month - 1]} ${day}`;
  return currentYear !== undefined && year !== currentYear ? `${label}, ${year}` : label;
}

function localToday() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const subscribe = () => () => {};

// The viewer's local date, or null during server render / hydration.
export function useToday(): string | null {
  return useSyncExternalStore(subscribe, localToday, () => null);
}

export function isOverdue(dueOn: string | null, today: string | null, completed: boolean) {
  return Boolean(dueOn && today && !completed && dueOn < today);
}
