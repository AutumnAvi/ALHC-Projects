# ALHC Projects

Our own project management software: projects, sections, tasks, and subtasks, with List and Board views and a task detail pane. Built with Next.js 16 (App Router), Supabase (Auth + Postgres + RLS), and Tailwind CSS 4, and deployed on Vercel.

Architecture, data-model rules, and conventions are documented in [`AGENTS.md`](./AGENTS.md).

## What's here (core spine)

- Google sign-in through Supabase Auth, gated by an email allowlist (`public.allowed_emails`). Non-allowlisted accounts are signed out and shown a denied screen.
- Data model: workspaces, projects, sections, tasks, subtasks, multi-project task membership (`task_projects`), and profiles. All deletes are soft (`deleted_at`).
- Row Level Security on every table. In this phase, any allowlisted user can read, create, and update all workspace data.
- Project home, List view (grouped by section), Board view (columns are sections, with drag-and-drop or a "move to section" menu), and a task detail pane (title, description, assignee, due date, subtasks, project memberships, delete).

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase URL + anon key
npm run dev                        # http://localhost:3000
```

Checks:

```bash
npm run lint
npm run typecheck
npm run build
npm run db:test   # applies migrations to a throwaway local Postgres and runs the RLS smoke test
```

`npm run db:test` needs PostgreSQL server binaries (`initdb`, `pg_ctl`) installed locally, e.g. `brew install postgresql@16` or `apt install postgresql`. It doesn't touch any Supabase project.

## Setup: Supabase

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard). Note the project ref (the `xxxx` in `https://xxxx.supabase.co`).
2. **Apply the migrations.** Either:
   - CLI: `npx supabase login`, then `npx supabase link --project-ref <ref>`, then `npx supabase db push`
   - or open the SQL editor and run each file in `supabase/migrations/` in filename order.
3. **Add people to the allowlist** in the SQL editor (use real Google account emails; they're normalised to lowercase):

   ```sql
   insert into public.allowed_emails (email, note)
   values ('avi@yourdomain.com', 'Avi');
   ```

   To remove access later, run `delete from public.allowed_emails where email = '...';`. Their next request gets signed out. `supabase/seed.sql` only contains a placeholder (`owner@example.com`) and is applied by `supabase db reset` for local stacks.
4. **Turn off email sign-ups** (Authentication → Sign In / Providers → Email → disable). Google is the only supported sign-in method. The allowlist also requires a confirmed email.

## Setup: Google OAuth

These steps have to be done by hand in the Google Cloud and Supabase consoles:

1. In [Google Cloud Console](https://console.cloud.google.com/), open APIs & Services → **OAuth consent screen**. Choose *Internal* if everyone uses one Google Workspace domain; otherwise choose *External* and add test users or publish the app.
2. Go to APIs & Services → **Credentials** → *Create credentials* → **OAuth client ID** → *Web application*.
   - **Authorized JavaScript origins:** `http://localhost:3000` and your production URL (e.g. `https://projects.example.com`).
   - **Authorized redirect URIs:** `https://<project-ref>.supabase.co/auth/v1/callback`
3. In Supabase, open Authentication → Sign In / Providers → **Google**. Enable it and paste the client ID and secret.
4. In Supabase, open Authentication → **URL Configuration**:
   - **Site URL:** your production URL
   - **Redirect URLs:** add all of these:
     - `http://localhost:3000/**`
     - `https://<production-domain>/**`
     - `https://*-<vercel-team-slug>.vercel.app/**` (lets Vercel preview deployments complete sign-in)

The app sends users to `/auth/callback?next=…` after Google sign-in. Supabase will only redirect to URLs that match the list above.

## Setup: Vercel

1. Import `AutumnAvi/ALHC-Projects` in Vercel. The framework preset (Next.js) and build command (`npm run build`) are detected automatically, so `vercel.json` isn't needed.
2. Under Settings → Environment Variables, set these for **Production** and **Preview**:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (or publishable) key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Optional. Not used yet; server-only if added |

   The Supabase ↔ Vercel Marketplace integration sets the same names automatically if you prefer it.
3. Deploy. If you add or change env vars later, redeploy so they take effect. Without them, every page shows a "Supabase isn't configured" screen instead of crashing.

## Project scripts

| Script | What it does |
| --- | --- |
| `dev` / `build` / `start` | Next.js |
| `lint` | ESLint (`eslint-config-next`) |
| `typecheck` | `tsc --noEmit` |
| `db:test` | Local migration + RLS smoke test |
| `db:types` | Regenerate `src/lib/supabase/database.types.ts` from the linked project (`npx supabase link` first) |
