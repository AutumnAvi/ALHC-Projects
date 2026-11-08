// AI builder pilot (experimental, feat/ai-builder): seeds the isolated "Testing data" workspace with the
// practice Asana export. See docs/ai-builder-pilot.md.
//
//   npm run ai-pilot:seed -- --source <export.json> [--manifest <manifest.json>] --account <email>
//                            [--map <asana gid or email>=account|placeholder]... [--marker <uuid>]
//                            [--name-suffix " (Testing data)"] [--report <file.json>] [--execute]
//
// Dry run unless --execute. Without credentials it only checks the export against the manifest (offline).
// Credentials come from the environment and are never printed: NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_ANON_KEY (the public anon key; a service-role / secret key is refused),
// ALHC_PILOT_EMAIL and ALHC_PILOT_PASSWORD (the selected account, which must equal --account).
// Every write is the signed-in account's own, through RLS and the existing importer.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { buildSeedPlan, checkManifest, type SeedPersonMode } from "@alhc/core/ai-pilot-seed";
import { seedPilot } from "@alhc/core/api/ai-pilot/mutations";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RFC 4122 version 5 (SHA-1, name-based): the same marker and source key always give the same id.
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function fail(message: string): never {
  console.error(`ai-pilot seed: ${message}`);
  process.exit(1);
}

function keyRole(key: string): string | null {
  if (key.startsWith("sb_secret_")) return "service_role";
  if (key.startsWith("sb_publishable_")) return "anon";
  const part = key.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      manifest: { type: "string" },
      account: { type: "string" },
      map: { type: "string", multiple: true },
      marker: { type: "string" },
      "name-suffix": { type: "string", default: " (Testing data)" },
      report: { type: "string" },
      execute: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.source) fail("--source <export.json> is required");
  if (!values.account) fail("--account <email> (the selected, signed-in account) is required");
  if (values.marker && !UUID.test(values.marker)) fail("--marker must be a uuid");
  const people: Record<string, SeedPersonMode> = {};
  for (const m of values.map ?? []) {
    const [who, mode] = m.split("=");
    if (!who || (mode !== "account" && mode !== "placeholder")) fail(`--map ${m}: use <asana gid or email>=account|placeholder`);
    people[who.trim().toLowerCase()] = mode;
  }

  const source: unknown = JSON.parse(readFileSync(values.source, "utf8"));
  const manifest: unknown = values.manifest ? JSON.parse(readFileSync(values.manifest, "utf8")) : null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.ALHC_PILOT_EMAIL;
  const password = process.env.ALHC_PILOT_PASSWORD;
  const online = !values.offline && Boolean(url && anonKey && email && password);
  if (values.execute && !online) fail("--execute needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, ALHC_PILOT_EMAIL, ALHC_PILOT_PASSWORD");

  let db: Db | null = null;
  let profileId = "";
  let marker = values.marker ?? null;
  if (online) {
    if (keyRole(anonKey!) !== "anon") fail("NEXT_PUBLIC_SUPABASE_ANON_KEY must be the public anon key (the seed never uses the service role)");
    if (email!.trim().toLowerCase() !== values.account.trim().toLowerCase()) fail("ALHC_PILOT_EMAIL must be the --account you selected");
    const client = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await client.auth.signInWithPassword({ email: email!, password: password! });
    if (signedIn.error || !signedIn.data.user) fail("couldn’t sign in as the selected account");
    profileId = signedIn.data.user.id;
    db = client as unknown as Db;
    if (!marker) {
      // Resume the pilot this account administers, if there is exactly one.
      const reg = await client.from("ai_pilot_workspaces").select("marker").is("cleaned_at", null);
      if (reg.error) fail(`couldn’t read the pilot registry (is the migration applied?): ${reg.error.code ?? "error"}`);
      if ((reg.data ?? []).length > 1) fail("more than one pilot is registered; pass --marker");
      marker = reg.data?.[0]?.marker ?? null;
    }
  }
  if (!marker) {
    marker = randomUUID();
    console.log(`New pilot marker: ${marker} (keep it; cleanup needs it)`);
  }

  const plan = buildSeedPlan(source, { marker, accountEmail: values.account, people, nameSuffix: values["name-suffix"] ?? "" });
  const manifestProblems = manifest ? checkManifest(plan, manifest) : [];
  console.log(`Plan: ${JSON.stringify(plan.expected)}`);
  for (const p of plan.people) console.log(`  person ${p.name}: ${p.mode}`);
  if (manifestProblems.length) fail(`the plan doesn’t match the manifest:\n  ${manifestProblems.join("\n  ")}`);
  if (manifest) console.log("Matches the manifest.");

  let report: unknown = { mode: "offline", marker, expected: plan.expected, people: plan.people, omissions: plan.omissions };
  if (db) {
    report = await seedPilot(createApiContext(db), plan, {
      marker,
      accountProfileId: profileId,
      idFor: (kind, gid) => uuidV5(marker!, `${kind}:${gid}`),
      execute: values.execute,
      log: (line) => console.log(line),
    });
  }
  console.log(JSON.stringify(report, null, 2));
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2));
  if (!values.execute) console.log("Dry run: nothing was written. Add --execute to seed.");
}

main().catch((error) => {
  if (isApiError(error)) fail(`${error.code}: ${error.message}`);
  fail(error instanceof Error ? error.message : "failed");
});
