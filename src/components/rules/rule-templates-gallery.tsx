"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CheckCircle2, Search, Sparkles } from "lucide-react";
import { useNotify, useServerAction } from "@/components/toast";
import { createRule } from "@/lib/actions";
import { RULE_TEMPLATES, TEMPLATE_CATEGORIES, type RuleTemplate, type TemplateCategory } from "@/lib/rule-templates";
import { RuleIcon } from "./rule-icons";
import type { RuleContext } from "./rule-shared";

// The Templates gallery (Automations V2, batch 3): ready-made marketing and creative rules. A card's
// "Add" installs it right away (off, so it can be checked first) when the project already has what it
// needs; otherwise "Use" opens the builder filled in, with the slots still to pick highlighted.
export function RuleTemplatesGallery({ projectId, ctx, canEdit }: { projectId: string; ctx: RuleContext; canEdit: boolean }) {
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [query, setQuery] = useState("");
  const templateCtx = useMemo(
    () => ({
      sections: ctx.sections,
      fields: ctx.fields.map((f) => ({
        id: f.id,
        name: f.name,
        fieldType: f.fieldType,
        boundToSections: f.boundToSections,
        options: f.options.map((o) => ({ id: o.id, name: o.name })),
      })),
      tags: (ctx.tags ?? []).map((t) => ({ id: t.id, name: t.name, archived: t.archived })),
      otherProjects: (ctx.otherProjects ?? []).map((p) => ({ id: p.id, name: p.name })),
    }),
    [ctx],
  );
  const q = query.trim().toLowerCase();
  const shown = RULE_TEMPLATES.filter(
    (t) =>
      (category === "all" || t.category === category) &&
      (!q || t.name.toLowerCase().includes(q) || t.sentence.toLowerCase().includes(q)),
  );

  return (
    <section aria-labelledby="rule-templates" className="mt-8" id="templates">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="rule-templates" className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <Sparkles className="size-4 text-accent-600" aria-hidden />
          Templates
        </h2>
        <span className="flex-1" />
        <label className="relative">
          <span className="sr-only">Search templates</span>
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search templates"
            className="control w-52 pl-7"
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Common marketing and creative rules. Sections, fields, and tags are matched by name; anything this project
        doesn’t have yet is left for you to pick. Templates are added turned off, so you can check them first.
      </p>
      <div role="tablist" aria-label="Template categories" className="tab-strip mt-3 gap-1">
        {[{ value: "all" as const, label: "All" }, ...TEMPLATE_CATEGORIES].map((c) => (
          <button
            key={c.value}
            type="button"
            role="tab"
            aria-selected={category === c.value}
            onClick={() => setCategory(c.value)}
            className="inline-flex h-8 shrink-0 items-center rounded-full px-3 text-xs text-zinc-600 hover:bg-zinc-100 aria-selected:bg-zinc-900 aria-selected:text-white"
          >
            {c.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500">
          No template matches “{query}”.
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {shown.map((t) => (
            <TemplateCard key={t.key} projectId={projectId} template={t} ctx={templateCtx} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateCard({
  projectId,
  template,
  ctx,
  canEdit,
}: {
  projectId: string;
  template: RuleTemplate;
  ctx: Parameters<RuleTemplate["build"]>[0];
  canEdit: boolean;
}) {
  const router = useRouter();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const built = useMemo(() => template.build(ctx), [template, ctx]);
  const useHref = `/projects/${projectId}/rules/new?template=${template.key}`;
  const ready = built.missing.length === 0;

  function add() {
    run(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await createRule(projectId, {
        name: built.name,
        triggerType: built.triggerType,
        triggerConfig: built.triggerConfig,
        conditions: built.conditions,
        actions: built.actions,
        enabled: false,
        timeZone,
      });
      if (!result.error && result.ruleId) {
        notify(`Added “${built.name}” (off). Check it, then turn it on.`);
        router.push(`/projects/${projectId}/rules/${result.ruleId}`);
      }
      return result;
    });
  }

  return (
    <li className="flex flex-col rounded-lg border border-zinc-200 bg-white p-3.5">
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-50 text-accent-700">
          <RuleIcon value={built.triggerType} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-900">{template.name}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-600">{template.sentence}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {ready ? (
          <span className="inline-flex items-center gap-1 text-green-700">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Ready for this project
          </span>
        ) : (
          <>You’ll pick: {built.missing.join(", ")}</>
        )}
      </p>
      {canEdit ? (
        <div className="mt-3 flex items-center gap-2">
          {ready ? (
            <button type="button" onClick={add} disabled={pending} className="btn-primary h-7 px-2.5 text-xs">
              {pending ? "Adding…" : "Add to project"}
            </button>
          ) : null}
          <Link href={useHref} className={`${ready ? "btn-ghost" : "btn-primary"} h-7 px-2.5 text-xs`}>
            {ready ? "Customize first" : "Use template"}
          </Link>
        </div>
      ) : null}
    </li>
  );
}
