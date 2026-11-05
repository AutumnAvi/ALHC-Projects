import { AuthCard } from "./auth-card";

export function SetupRequired() {
  return (
    <AuthCard title="Supabase isn’t configured">
      <p className="text-sm text-zinc-600">
        Set <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> for this
        environment (locally in <code className="font-mono text-xs">.env.local</code>, or in the
        Vercel project settings), then redeploy. See the README for the full setup.
      </p>
    </AuthCard>
  );
}
