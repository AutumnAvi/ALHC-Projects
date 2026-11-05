"use server";
// Big move 1: a person's project access for the Members page and Admin console → Users (Oct 25 notes,
// note 2), a thin wrapper around packages/core/src/api/people/queries.ts, read with the signed-in person's own
// context (RLS decides). Changes go through the members actions, which the database checks again.
import * as peopleApi from "@alhc/core/api/people/queries";
import type { PersonProjectAccess } from "@alhc/core/api/shell/model";
import { actionContext } from "@/lib/server/context";


export async function loadPersonProjectAccess(person: {
  email: string;
  profileId: string | null;
}): Promise<PersonProjectAccess | null> {
  return peopleApi.loadPersonProjectAccess(await actionContext(), person);
}
