-- Nov 11 batch 38 (notes 189 and 192). Additive: three asserted patches and a column default; no object
-- or row is removed, nothing is backfilled, no tail.
--
-- 189. A comment's text can be changed only for 15 minutes after it was posted (counted from created_at,
--      so an edit never extends the window). guard_comment_update (comments_05_guard_update, runs as the
--      caller) refuses a person's later change of the body with "Comments can only be edited for 15
--      minutes". Removing a comment (setting deleted_at; the scrub trigger then clears its text) has no
--      time limit, and system code (rules, imports, the scrub) isn't checked, as before. The app checks
--      the same rule first (packages/core/src/comment-edit.ts) so people read that message.
-- 192. New forms start with "Only allow verified-domain emails to submit" on: forms.verified_domains_only
--      defaults to true. Existing forms keep what they have (no update). Project templates and Duplicate
--      project now carry each form's flag (project_snapshot adds it), and a form from a snapshot without
--      the flag (templates saved before this release) starts on, like any new form.

create or replace function public.alhc_patch_function(target regprocedure, variadic edits text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  def text := pg_get_functiondef(target);
  hits integer;
begin
  if coalesce(array_length(edits, 1), 0) = 0 or array_length(edits, 1) % 2 <> 0 then
    raise exception 'alhc_patch_function(%): pass (old, new) text pairs', target;
  end if;
  for i in 1 .. array_length(edits, 1) / 2 loop
    if coalesce(edits[2 * i - 1], '') = '' then
      raise exception 'alhc_patch_function(%): edit % has no text to replace', target, i;
    end if;
    hits := (length(def) - length(replace(def, edits[2 * i - 1], ''))) / length(edits[2 * i - 1]);
    if hits <> 1 then
      raise exception 'alhc_patch_function(%): edit % matched % times (expected exactly once)', target, i, hits;
    end if;
    def := replace(def, edits[2 * i - 1], edits[2 * i]);
  end loop;
  execute def;
end;
$$;

revoke all on function public.alhc_patch_function(regprocedure, text[]) from public, anon, authenticated;

-- 189. The 15-minute window for a person's edit of a comment's text.
select public.alhc_patch_function(
  'public.guard_comment_update()'::regprocedure,
  $old$      raise exception 'Only the text of a comment can be edited' using errcode = 'insufficient_privilege';
    end if;
  end if;$old$,
  $new$      raise exception 'Only the text of a comment can be edited' using errcode = 'insufficient_privilege';
    end if;
    -- Nov 11 batch 38 (note 189): the text only for 15 minutes after posting; removing it any time.
    if new.body is distinct from old.body
       and new.deleted_at is null
       and now() - old.created_at > interval '15 minutes' then
      raise exception 'Comments can only be edited for 15 minutes' using errcode = 'check_violation';
    end if;
  end if;$new$
);

comment on function public.guard_comment_update() is
  'Clients may change only an active comment''s text (for 15 minutes after it was posted; Nov 11 batch 38, '
  'note 189) or soft-remove it (any time). A text change stamps edited_at.';

-- 192. New forms only take verified-domain submitters unless someone turns it off.
alter table public.forms alter column verified_domains_only set default true;

comment on column public.forms.verified_domains_only is
  'Only addresses on one of the workspace''s verified domains may submit (submit_form refuses others). '
  'On by default for new forms since Nov 11 batch 38 (note 192); forms made before keep their value.';

-- 192. Copies keep each form's flag; a snapshot without it (older templates) makes the form start on.
select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $old$        'confirmation_message', fm.confirmation_message
      ) order by fm.created_at)$old$,
  $new$        'confirmation_message', fm.confirmation_message,
        'verified_domains_only', fm.verified_domains_only
      ) order by fm.created_at)$new$
);

select public.alhc_patch_function(
  'public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)'::regprocedure,
  $old$        send_confirmation, confirmation_message, created_by)$old$,
  $new$        send_confirmation, confirmation_message, verified_domains_only, created_by)$new$,
  $old$        item ->> 'confirmation_message',
        me$old$,
  $new$        item ->> 'confirmation_message',
        coalesce((item ->> 'verified_domains_only')::boolean, true),
        me$new$
);
