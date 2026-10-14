"use client";

// These modules are used by several project screens. Importing them from the shell
// keeps one shared copy instead of a second copy inside every route bundle.
import { ProjectAccessProvider } from "@/components/project/project-access";
import { requestAddTask } from "@/components/project/shared";
import { useDependencyShift } from "@/components/task/dependency-shift";

export const sharedClientModules = [ProjectAccessProvider, requestAddTask, useDependencyShift];
