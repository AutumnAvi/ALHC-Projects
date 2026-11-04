import "server-only";
// Big move 1: the Next.js adapter for the layer's reads. Each binding calls the layer (src/lib/api/) with
// the render's context (src/lib/server/context.ts: the person's own client, and one memo per render so
// the layout, the page, and every read under them share answers, as React's cache() did).
import { bind } from "@/lib/server/context";
import * as screensApi from "@/lib/api/screens/queries";

export const loadAppShell = bind(screensApi.loadAppShell);
export const loadProjectFrame = bind(screensApi.loadProjectFrame);
export const loadProjectViewPage = bind(screensApi.loadProjectViewPage);
export const loadMyTasksScreen = bind(screensApi.loadMyTasksScreen);
export const loadHomeScreen = bind(screensApi.loadHomeScreen);
