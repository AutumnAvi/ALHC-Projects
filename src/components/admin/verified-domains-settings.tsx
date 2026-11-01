"use client";

import { useOptimistic, useState } from "react";
import { Globe, X } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { useServerAction } from "@/components/toast";
import { addVerifiedDomain, removeVerifiedDomain, setVerifiedDomainConversations } from "@/lib/actions";
import type { VerifiedDomain } from "@/lib/data";
import { normalizeDomainInput } from "@/lib/verified-domains";

// Admin console → Security → Verified domains (Nov 1 notes, item 69): the domains whose addresses count
// as verified, and whether only they get the reply-by-email conversation on requests. Not the sign-up
// allowlist: who can sign in is still decided per address (Allowlist above).
export function VerifiedDomainsSettings({
  domains,
  conversationsVerifiedOnly,
}: {
  domains: VerifiedDomain[];
  conversationsVerifiedOnly: boolean;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [draft, setDraft] = useState("");
  const [tried, setTried] = useState(false);
  const [on, setOn] = useOptimistic(conversationsVerifiedOnly);
  const [list, removeFromList] = useOptimistic(domains, (current, domainId: string) => current.filter((d) => d.id !== domainId));
  const clean = normalizeDomainInput(draft);

  function add() {
    setTried(true);
    if (!clean) return;
    run(async () => {
      const result = await addVerifiedDomain(clean);
      if (!result.error) {
        setDraft("");
        setTried(false);
      }
      return result;
    });
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            run(
              () => setVerifiedDomainConversations(next),
              () => setOn(next),
            );
          }}
          className="mt-0.5 size-4 accent-accent-600"
        />
        <span className="min-w-0 text-sm">
          <span className="font-medium text-zinc-900">Only verified domains get email conversations on requests</span>
          <span className="block text-xs text-zinc-500">
            {on
              ? "Requesters at these domains can trade emails with the team from the task. Anyone else can still submit forms, but gets no email back-and-forth (workers see why in the task). A workspace admin can turn it on for a request or a submitter from the task."
              : "Off: every form submitter can get responses by email and reply to them."}
          </span>
        </span>
      </label>

      <div>
        <p className="text-xs font-medium text-zinc-600">Verified domains</p>
        {list.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">No verified domains. Add one below.</p>
        ) : (
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Verified domains">
            {list.map((d) => (
              <li
                key={d.id}
                data-verified-domain={d.domain}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white py-0.5 pr-1 pl-2 text-sm text-zinc-800"
              >
                <Globe className="size-3.5 text-zinc-400" aria-hidden />
                {d.domain}
                <button
                  type="button"
                  aria-label={`Remove ${d.domain}`}
                  data-tooltip="Remove"
                  disabled={pending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${d.domain}?`,
                        message: "Requesters at this domain stop getting email conversations (unless an admin allows them), and verified-only forms stop taking their submissions.",
                        confirmLabel: "Remove",
                        tone: "danger",
                      })
                    ) {
                      run(
                        () => removeVerifiedDomain(d.id),
                        () => removeFromList(d.id),
                      );
                    }
                  }}
                  className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label htmlFor="verified-domain-new" className="sr-only">
            Add a domain
          </label>
          <input
            id="verified-domain-new"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            placeholder="example.com"
            aria-invalid={tried && !clean ? true : undefined}
            aria-describedby="verified-domain-help"
            className="field h-8 w-64"
          />
          <button type="submit" disabled={pending || !draft.trim()} className="btn-primary h-8">
            Add domain
          </button>
          <p id="verified-domain-help" className={`basis-full text-xs ${tried && !clean ? "text-red-700" : "text-zinc-500"}`}>
            {tried && !clean
              ? "Enter a domain like example.com"
              : "Just the part after the @. Verification is the address the person enters; this doesn’t change who can sign in."}
          </p>
        </form>
      </div>
    </div>
  );
}
