// Mirrors supabase/migrations in the shape produced by `supabase gen types typescript`.
// Regenerate with `npm run db:types` once a Supabase project is linked, and keep in sync with migrations.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
  public: {
    Tables: {
      allowed_emails: {
        Row: {
          email: string;
          note: string | null;
          created_at: string;
          invited_by: string | null;
          invited_at: string | null;
          removed_at: string | null;
          removed_by: string | null;
        };
        Insert: {
          email: string;
          note?: string | null;
          created_at?: string;
          invited_by?: string | null;
          invited_at?: string | null;
          removed_at?: string | null;
          removed_by?: string | null;
        };
        Update: {
          email?: string;
          note?: string | null;
          created_at?: string;
          invited_by?: string | null;
          invited_at?: string | null;
          removed_at?: string | null;
          removed_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "allowed_emails_invited_by_fkey";
            columns: ["invited_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allowed_emails_removed_by_fkey";
            columns: ["removed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      approval_requests: {
        Row: {
          id: string;
          task_id: string;
          subtask_id: string | null;
          approver_id: string;
          requested_by: string | null;
          rule_id: string | null;
          note: string | null;
          status: string;
          decided_by: string | null;
          decided_at: string | null;
          decision_note: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          subtask_id?: string | null;
          approver_id: string;
          requested_by?: string | null;
          rule_id?: string | null;
          note?: string | null;
          status?: string;
          decided_by?: string | null;
          decided_at?: string | null;
          decision_note?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          subtask_id?: string | null;
          approver_id?: string;
          requested_by?: string | null;
          rule_id?: string | null;
          note?: string | null;
          status?: string;
          decided_by?: string | null;
          decided_at?: string | null;
          decision_note?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      comment_mentions: {
        Row: {
          comment_id: string;
          profile_id: string;
          created_at: string;
        };
        Insert: {
          comment_id: string;
          profile_id: string;
          created_at?: string;
        };
        Update: {
          comment_id?: string;
          profile_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "comment_mentions_comment_id_fkey";
            columns: ["comment_id"];
            isOneToOne: false;
            referencedRelation: "comments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "comment_mentions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      comment_reactions: {
        Row: {
          id: string;
          comment_id: string;
          task_id: string;
          profile_id: string;
          emoji: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          comment_id: string;
          task_id?: string;
          profile_id?: string;
          emoji: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          comment_id?: string;
          task_id?: string;
          profile_id?: string;
          emoji?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "comment_reactions_comment_id_fkey";
            columns: ["comment_id"];
            isOneToOne: false;
            referencedRelation: "comments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "comment_reactions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "comment_reactions_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      comments: {
        Row: {
          id: string;
          task_id: string;
          author_id: string | null;
          body: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          edited_at: string | null;
          rule_id: string | null;
          email_direction: string | null;
          email_address: string | null;
          email_subject: string | null;
          email_skipped_files: Json | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          author_id?: string | null;
          body: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          rule_id?: string | null;
          email_direction?: string | null;
          email_address?: string | null;
          email_subject?: string | null;
          email_skipped_files?: Json | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          author_id?: string | null;
          body?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          rule_id?: string | null;
          email_direction?: string | null;
          email_address?: string | null;
          email_subject?: string | null;
          email_skipped_files?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "comments_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "comments_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      custom_fields: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          field_type: string;
          options: Json;
          bound_to_sections: boolean;
          show_in_views: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          // Asana parity, batch 4 (20261011040000_asana_parity_4.sql): absent on a database without it.
          description?: string | null;
          notify_on_change?: boolean;
          in_library?: boolean;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          field_type: string;
          options?: Json;
          bound_to_sections?: boolean;
          show_in_views?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          notify_on_change?: boolean;
          in_library?: boolean;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          field_type?: string;
          options?: Json;
          bound_to_sections?: boolean;
          show_in_views?: boolean;
          description?: string | null;
          notify_on_change?: boolean;
          in_library?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "custom_fields_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      dashboard_widgets: {
        Row: {
          id: string;
          project_id: string;
          kind: string;
          title: string;
          filters: Json;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          kind: string;
          title: string;
          filters?: Json;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          kind?: string;
          title?: string;
          filters?: Json;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      email_outbox: {
        Row: {
          id: string;
          task_id: string | null;
          rule_id: string | null;
          to_email: string;
          template: string;
          subject: string | null;
          payload: Json;
          status: string;
          attempts: number;
          last_error: string | null;
          provider_message_id: string | null;
          send_after: string;
          sent_at: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          to_profile_id: string | null;
          comment_id: string | null;
          max_attempts: number;
          delivery_status: string | null;
          delivery_event_at: string | null;
          delivery_detail: string | null;
        };
        Insert: {
          id?: string;
          task_id?: string | null;
          rule_id?: string | null;
          to_email: string;
          template: string;
          subject?: string | null;
          payload?: Json;
          status?: string;
          attempts?: number;
          last_error?: string | null;
          provider_message_id?: string | null;
          send_after?: string;
          sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          to_profile_id?: string | null;
          comment_id?: string | null;
          max_attempts?: number;
          delivery_status?: string | null;
          delivery_event_at?: string | null;
          delivery_detail?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string | null;
          rule_id?: string | null;
          to_email?: string;
          template?: string;
          subject?: string | null;
          payload?: Json;
          status?: string;
          attempts?: number;
          last_error?: string | null;
          provider_message_id?: string | null;
          send_after?: string;
          sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          to_profile_id?: string | null;
          comment_id?: string | null;
          max_attempts?: number;
          delivery_status?: string | null;
          delivery_event_at?: string | null;
          delivery_detail?: string | null;
        };
        Relationships: [];
      };
      email_replies: {
        Row: {
          id: string;
          provider_id: string | null;
          token_id: string | null;
          thread_id: string | null;
          task_id: string | null;
          profile_id: string | null;
          comment_id: string | null;
          status: string;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          provider_id?: string | null;
          token_id?: string | null;
          thread_id?: string | null;
          task_id?: string | null;
          profile_id?: string | null;
          comment_id?: string | null;
          status: string;
          reason?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          provider_id?: string | null;
          token_id?: string | null;
          thread_id?: string | null;
          task_id?: string | null;
          profile_id?: string | null;
          comment_id?: string | null;
          status?: string;
          reason?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      submitter_reply_threads: {
        Row: {
          id: string;
          task_id: string;
          submission_id: string | null;
          submitter_email: string;
          subject: string;
          token: string;
          created_by: string | null;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
          closed_at: string | null;
          closed_by: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          submission_id?: string | null;
          submitter_email: string;
          subject: string;
          token: string;
          created_by?: string | null;
          created_at?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          submission_id?: string | null;
          submitter_email?: string;
          subject?: string;
          token?: string;
          created_by?: string | null;
          created_at?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
        };
        Relationships: [];
      };
      email_reply_tokens: {
        Row: {
          id: string;
          task_id: string;
          profile_id: string;
          token: string;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          profile_id: string;
          token: string;
          created_at?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          profile_id?: string;
          token?: string;
          created_at?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      email_forwarding_addresses: {
        Row: {
          id: string;
          profile_id: string;
          token: string;
          default_project_id: string | null;
          created_at: string;
          updated_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          token?: string;
          default_project_id?: string | null;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          profile_id?: string;
          token?: string;
          default_project_id?: string | null;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      email_designs: {
        Row: {
          id: string;
          workspace_id: string;
          kind: string;
          project_id: string | null;
          form_id: string | null;
          logo_path: string | null;
          accent_color: string | null;
          header_text: string | null;
          intro_message: string | null;
          footer_text: string | null;
          button_label: string | null;
          button_color: string | null;
          subject_template: string | null;
          heading_text: string | null;
          notice_text: string | null;
          show_logo: boolean | null;
          show_header: boolean | null;
          show_heading: boolean | null;
          show_intro: boolean | null;
          show_body: boolean | null;
          show_details: boolean | null;
          show_button: boolean | null;
          show_notice: boolean | null;
          show_footer: boolean | null;
          created_by: string | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          kind: string;
          project_id?: string | null;
          form_id?: string | null;
          logo_path?: string | null;
          accent_color?: string | null;
          header_text?: string | null;
          intro_message?: string | null;
          footer_text?: string | null;
          button_label?: string | null;
          button_color?: string | null;
          subject_template?: string | null;
          heading_text?: string | null;
          notice_text?: string | null;
          show_logo?: boolean | null;
          show_header?: boolean | null;
          show_heading?: boolean | null;
          show_intro?: boolean | null;
          show_body?: boolean | null;
          show_details?: boolean | null;
          show_button?: boolean | null;
          show_notice?: boolean | null;
          show_footer?: boolean | null;
          created_by?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          kind?: string;
          project_id?: string | null;
          form_id?: string | null;
          logo_path?: string | null;
          accent_color?: string | null;
          header_text?: string | null;
          intro_message?: string | null;
          footer_text?: string | null;
          button_label?: string | null;
          button_color?: string | null;
          subject_template?: string | null;
          heading_text?: string | null;
          notice_text?: string | null;
          show_logo?: boolean | null;
          show_header?: boolean | null;
          show_heading?: boolean | null;
          show_intro?: boolean | null;
          show_body?: boolean | null;
          show_details?: boolean | null;
          show_button?: boolean | null;
          show_notice?: boolean | null;
          show_footer?: boolean | null;
          created_by?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      email_forwards: {
        Row: {
          id: string;
          provider_id: string | null;
          address_id: string | null;
          profile_id: string | null;
          task_id: string | null;
          project_id: string | null;
          status: string;
          reason: string | null;
          attachments: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          provider_id?: string | null;
          address_id?: string | null;
          profile_id?: string | null;
          task_id?: string | null;
          project_id?: string | null;
          status: string;
          reason?: string | null;
          attachments?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          provider_id?: string | null;
          address_id?: string | null;
          profile_id?: string | null;
          task_id?: string | null;
          project_id?: string | null;
          status?: string;
          reason?: string | null;
          attachments?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      form_submissions: {
        Row: {
          id: string;
          form_id: string;
          task_id: string;
          submitter_email: string;
          submitter_id: string | null;
          answers: Json;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          form_id: string;
          task_id: string;
          submitter_email: string;
          submitter_id?: string | null;
          answers?: Json;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          form_id?: string;
          task_id?: string;
          submitter_email?: string;
          submitter_id?: string | null;
          answers?: Json;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      forms: {
        Row: {
          id: string;
          project_id: string;
          title: string;
          description: string | null;
          questions: Json;
          destination_section_id: string | null;
          accepting_responses: boolean;
          send_confirmation: boolean;
          confirmation_message: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          title: string;
          description?: string | null;
          questions?: Json;
          destination_section_id?: string | null;
          accepting_responses?: boolean;
          send_confirmation?: boolean;
          confirmation_message?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          title?: string;
          description?: string | null;
          questions?: Json;
          destination_section_id?: string | null;
          accepting_responses?: boolean;
          send_confirmation?: boolean;
          confirmation_message?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      import_external_ids: {
        Row: {
          id: string;
          project_id: string;
          source: string;
          kind: string;
          external_id: string;
          local_id: string;
          run_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          source: string;
          kind: string;
          external_id: string;
          local_id: string;
          run_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          source?: string;
          kind?: string;
          external_id?: string;
          local_id?: string;
          run_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      import_runs: {
        Row: {
          id: string;
          project_id: string;
          source: string;
          status: string;
          file_names: string[];
          summary: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          finished_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          source: string;
          status?: string;
          file_names?: string[];
          summary?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          finished_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          source?: string;
          status?: string;
          file_names?: string[];
          summary?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          finished_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "import_runs_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "import_runs_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      inbound_calls: {
        Row: {
          id: string;
          endpoint_id: string;
          project_id: string;
          status: string;
          http_status: number;
          task_id: string | null;
          error: string | null;
          warnings: Json;
          idempotency_key: string | null;
          replay_digest: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          endpoint_id: string;
          project_id: string;
          status: string;
          http_status: number;
          task_id?: string | null;
          error?: string | null;
          warnings?: Json;
          idempotency_key?: string | null;
          replay_digest?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          endpoint_id?: string;
          project_id?: string;
          status?: string;
          http_status?: number;
          task_id?: string | null;
          error?: string | null;
          warnings?: Json;
          idempotency_key?: string | null;
          replay_digest?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "inbound_calls_endpoint_id_fkey";
            columns: ["endpoint_id"];
            isOneToOne: false;
            referencedRelation: "inbound_endpoints";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbound_calls_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbound_calls_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      inbound_endpoints: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          section_id: string | null;
          assignee_id: string | null;
          tag_ids: string[];
          enabled: boolean;
          token_hash: string;
          token_hint: string;
          token_rotated_at: string;
          signing_secret: string | null;
          signing_secret_set_at: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          section_id?: string | null;
          assignee_id?: string | null;
          tag_ids?: string[];
          enabled?: boolean;
          token_hash?: string;
          token_hint?: string;
          token_rotated_at?: string;
          signing_secret?: string | null;
          signing_secret_set_at?: string | null;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          section_id?: string | null;
          assignee_id?: string | null;
          tag_ids?: string[];
          enabled?: boolean;
          token_hash?: string;
          token_hint?: string;
          token_rotated_at?: string;
          signing_secret?: string | null;
          signing_secret_set_at?: string | null;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "inbound_endpoints_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbound_endpoints_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbound_endpoints_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbound_endpoints_section_id_fkey";
            columns: ["section_id"];
            isOneToOne: false;
            referencedRelation: "sections";
            referencedColumns: ["id"];
          },
        ];
      };
      inbox_items: {
        Row: {
          id: string;
          recipient_id: string;
          actor_id: string | null;
          task_id: string | null;
          message_id: string | null;
          team_message_id: string | null;
          status_update_id: string | null;
          comment_id: string | null;
          kind: string;
          read_at: string | null;
          archived_at: string | null;
          bookmarked_at: string | null;
          created_at: string;
          data: Json;
        };
        Insert: {
          id?: string;
          recipient_id: string;
          actor_id?: string | null;
          task_id?: string | null;
          message_id?: string | null;
          team_message_id?: string | null;
          status_update_id?: string | null;
          comment_id?: string | null;
          kind: string;
          read_at?: string | null;
          archived_at?: string | null;
          bookmarked_at?: string | null;
          created_at?: string;
          data?: Json;
        };
        Update: {
          id?: string;
          recipient_id?: string;
          actor_id?: string | null;
          task_id?: string | null;
          message_id?: string | null;
          team_message_id?: string | null;
          status_update_id?: string | null;
          comment_id?: string | null;
          kind?: string;
          read_at?: string | null;
          archived_at?: string | null;
          bookmarked_at?: string | null;
          created_at?: string;
          data?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "inbox_items_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "project_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_items_team_message_id_fkey";
            columns: ["team_message_id"];
            isOneToOne: false;
            referencedRelation: "team_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_items_status_update_id_fkey";
            columns: ["status_update_id"];
            isOneToOne: false;
            referencedRelation: "project_status_updates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_items_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_items_comment_id_fkey";
            columns: ["comment_id"];
            isOneToOne: false;
            referencedRelation: "comments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_items_recipient_id_fkey";
            columns: ["recipient_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_items_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_outbox: {
        Row: {
          id: string;
          channel: string;
          project_id: string;
          task_id: string | null;
          rule_id: string | null;
          rule_run_id: string | null;
          target_url: string;
          target_hint: string;
          headers: Json;
          payload: Json;
          status: string;
          attempts: number;
          last_error: string | null;
          provider_response: Json | null;
          send_after: string;
          sent_at: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          signing_secret: string | null;
          max_attempts: number;
        };
        Insert: {
          id?: string;
          channel: string;
          project_id: string;
          task_id?: string | null;
          rule_id?: string | null;
          rule_run_id?: string | null;
          target_url: string;
          target_hint: string;
          headers?: Json;
          payload: Json;
          status?: string;
          attempts?: number;
          last_error?: string | null;
          provider_response?: Json | null;
          send_after?: string;
          sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          signing_secret?: string | null;
          max_attempts?: number;
        };
        Update: {
          id?: string;
          channel?: string;
          project_id?: string;
          task_id?: string | null;
          rule_id?: string | null;
          rule_run_id?: string | null;
          target_url?: string;
          target_hint?: string;
          headers?: Json;
          payload?: Json;
          status?: string;
          attempts?: number;
          last_error?: string | null;
          provider_response?: Json | null;
          send_after?: string;
          sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          signing_secret?: string | null;
          max_attempts?: number;
        };
        Relationships: [];
      };
      integration_secrets: {
        Row: {
          id: string;
          project_id: string;
          rule_id: string | null;
          kind: string;
          value: string;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          rule_id?: string | null;
          kind: string;
          value: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          rule_id?: string | null;
          kind?: string;
          value?: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      my_task_placements: {
        Row: {
          id: string;
          profile_id: string;
          task_id: string;
          section_id: string;
          sort_order: number;
          assigned_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          task_id: string;
          section_id: string;
          sort_order?: number;
          assigned_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          profile_id?: string;
          task_id?: string;
          section_id?: string;
          sort_order?: number;
          assigned_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "my_task_placements_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "my_task_placements_section_id_fkey";
            columns: ["section_id"];
            isOneToOne: false;
            referencedRelation: "my_task_sections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "my_task_placements_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      personal_dashboards: {
        Row: {
          id: string;
          profile_id: string;
          name: string;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          name: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          profile_id?: string;
          name?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "personal_dashboards_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      personal_dashboard_widgets: {
        Row: {
          id: string;
          dashboard_id: string;
          profile_id: string;
          kind: string;
          title: string;
          filters: Json;
          series_interval: string;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          dashboard_id: string;
          profile_id?: string;
          kind: string;
          title: string;
          filters?: Json;
          series_interval?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          dashboard_id?: string;
          profile_id?: string;
          kind?: string;
          title?: string;
          filters?: Json;
          series_interval?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "personal_dashboard_widgets_dashboard_id_fkey";
            columns: ["dashboard_id"];
            isOneToOne: false;
            referencedRelation: "personal_dashboards";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "personal_dashboard_widgets_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      my_task_sections: {
        Row: {
          id: string;
          profile_id: string;
          kind: string;
          name: string;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          kind?: string;
          name: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          profile_id?: string;
          kind?: string;
          name?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "my_task_sections_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
          email_comments: boolean;
          joined_at: string | null;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
          email_comments?: boolean;
          joined_at?: string | null;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
          email_comments?: boolean;
          joined_at?: string | null;
        };
        Relationships: [];
      };
      portfolio_members: {
        Row: {
          id: string;
          portfolio_id: string;
          profile_id: string;
          role: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          portfolio_id: string;
          profile_id: string;
          role: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          portfolio_id?: string;
          profile_id?: string;
          role?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portfolio_members_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_members_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_members_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolio_projects: {
        Row: {
          id: string;
          portfolio_id: string;
          project_id: string;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          portfolio_id: string;
          project_id: string;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          portfolio_id?: string;
          project_id?: string;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portfolio_projects_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_projects_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_projects_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolios: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portfolios_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolios_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      project_integrations: {
        Row: {
          project_id: string;
          slack_webhook_url: string | null;
          webhook_url: string | null;
          webhook_secret_header: string | null;
          webhook_secret: string | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          project_id: string;
          slack_webhook_url?: string | null;
          webhook_url?: string | null;
          webhook_secret_header?: string | null;
          webhook_secret?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          project_id?: string;
          slack_webhook_url?: string | null;
          webhook_url?: string | null;
          webhook_secret_header?: string | null;
          webhook_secret?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      project_members: {
        Row: {
          id: string;
          project_id: string;
          profile_id: string;
          role: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          profile_id: string;
          role: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          profile_id?: string;
          role?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_members_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_members_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      project_stories: {
        Row: {
          id: string;
          project_id: string;
          actor_id: string | null;
          kind: string;
          data: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          actor_id?: string | null;
          kind: string;
          data?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          actor_id?: string | null;
          kind?: string;
          data?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_stories_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_stories_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_templates: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          content: Json;
          summary: Json;
          source_project_id: string | null;
          is_example: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
          content: Json;
          summary?: Json;
          source_project_id?: string | null;
          is_example?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string | null;
          content?: Json;
          summary?: Json;
          source_project_id?: string | null;
          is_example?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_templates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_templates_source_project_id_fkey";
            columns: ["source_project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_templates_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      project_views: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          layout: string;
          config: Json;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          layout: string;
          config?: Json;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          layout?: string;
          config?: Json;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          approval_completes_task: boolean;
          status: string;
          status_note: string | null;
          status_updated_at: string | null;
          status_updated_by: string | null;
          archived_at: string | null;
          archived_by: string | null;
          team_id: string;
          visibility: string;
          due_on: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          approval_completes_task?: boolean;
          status?: string;
          status_note?: string | null;
          status_updated_at?: string | null;
          status_updated_by?: string | null;
          archived_at?: string | null;
          archived_by?: string | null;
          team_id?: string | null;
          visibility?: string;
          due_on?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string | null;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          approval_completes_task?: boolean;
          status?: string;
          status_note?: string | null;
          status_updated_at?: string | null;
          status_updated_by?: string | null;
          archived_at?: string | null;
          archived_by?: string | null;
          team_id?: string;
          visibility?: string;
          due_on?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "projects_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_status_updated_by_fkey";
            columns: ["status_updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      request_sequences: {
        Row: {
          project_id: string;
          enabled: boolean;
          prefix: string;
          pad_width: number;
          add_to_title: boolean;
          assign_to: string;
          last_number: number;
          template: string;
          wrap_brackets: boolean;
          number_subtasks: boolean;
          subtask_separator: string;
          number_scope: string;
          section_ids: string[];
          task_kinds: string[];
          reuse_deleted: boolean;
          reuse_since: string | null;
          fill_gaps: boolean;
          reset_period: string;
          counter_field_id: string | null;
          project_code: string | null;
          renumber_on_move: boolean;
          time_zone: string;
          start_number: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          project_id: string;
          enabled?: boolean;
          prefix?: string;
          pad_width?: number;
          add_to_title?: boolean;
          assign_to?: string;
          last_number?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          project_id?: string;
          enabled?: boolean;
          prefix?: string;
          pad_width?: number;
          add_to_title?: boolean;
          assign_to?: string;
          last_number?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      rule_presets: {
        Row: {
          key: string;
          name: string;
          description: string;
          inputs: Json;
          rules: Json;
          sort_order: number;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          key: string;
          name: string;
          description: string;
          inputs?: Json;
          rules: Json;
          sort_order?: number;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          key?: string;
          name?: string;
          description?: string;
          inputs?: Json;
          rules?: Json;
          sort_order?: number;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      rule_runs: {
        Row: {
          id: string;
          rule_id: string;
          task_id: string | null;
          trigger_type: string;
          status: string;
          detail: Json;
          dedupe_key: string | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          rule_id: string;
          task_id?: string | null;
          trigger_type: string;
          status: string;
          detail?: Json;
          dedupe_key?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          rule_id?: string;
          task_id?: string | null;
          trigger_type?: string;
          status?: string;
          detail?: Json;
          dedupe_key?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      rules: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          enabled: boolean;
          trigger_type: string;
          trigger_config: Json;
          conditions: Json;
          actions: Json;
          preset_key: string | null;
          created_by: string | null;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          owner_id: string | null;
          next_run_at: string | null;
          last_edited_by: string | null;
          last_edited_at: string | null;
          run_on_rule_changes: boolean;
          paused_at: string | null;
          pause_reason: string | null;
          consecutive_failures: number;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          enabled?: boolean;
          trigger_type: string;
          trigger_config?: Json;
          conditions?: Json;
          actions?: Json;
          preset_key?: string | null;
          created_by?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          owner_id?: string | null;
          next_run_at?: string | null;
          last_edited_by?: string | null;
          last_edited_at?: string | null;
          run_on_rule_changes?: boolean;
          paused_at?: string | null;
          pause_reason?: string | null;
          consecutive_failures?: number;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          enabled?: boolean;
          trigger_type?: string;
          trigger_config?: Json;
          conditions?: Json;
          actions?: Json;
          preset_key?: string | null;
          created_by?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          owner_id?: string | null;
          next_run_at?: string | null;
          last_edited_by?: string | null;
          last_edited_at?: string | null;
          run_on_rule_changes?: boolean;
          paused_at?: string | null;
          pause_reason?: string | null;
          consecutive_failures?: number;
        };
        Relationships: [];
      };
      scheduled_rule_actions: {
        Row: {
          id: string;
          rule_id: string;
          task_id: string;
          actions: Json;
          event: Json;
          run_at: string;
          status: string;
          completed_at: string | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          rule_id: string;
          task_id: string;
          actions: Json;
          event?: Json;
          run_at: string;
          status?: string;
          completed_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          rule_id?: string;
          task_id?: string;
          actions?: Json;
          event?: Json;
          run_at?: string;
          status?: string;
          completed_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      sections: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sections_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      subtasks: {
        Row: {
          id: string;
          task_id: string;
          title: string;
          completed_at: string | null;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          title: string;
          completed_at?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          title?: string;
          completed_at?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "subtasks_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      task_dependencies: {
        Row: {
          id: string;
          project_id: string | null;
          predecessor_id: string;
          successor_id: string;
          kind: string;
          lag_days: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id?: string | null;
          predecessor_id: string;
          successor_id: string;
          kind?: string;
          lag_days?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string | null;
          predecessor_id?: string;
          successor_id?: string;
          kind?: string;
          lag_days?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_dependencies_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_dependencies_predecessor_id_fkey";
            columns: ["predecessor_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_dependencies_successor_id_fkey";
            columns: ["successor_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_dependencies_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      task_attachment_links: {
        Row: {
          id: string;
          task_id: string;
          source: string;
          name: string;
          url: string | null;
          attachment_id: string | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          source: string;
          name: string;
          url?: string | null;
          attachment_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          source?: string;
          name?: string;
          url?: string | null;
          attachment_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      task_attachments: {
        Row: {
          id: string;
          task_id: string;
          storage_path: string;
          file_name: string;
          content_type: string | null;
          size_bytes: number;
          uploaded_by: string;
          created_at: string;
          deleted_at: string | null;
          source: string;
          comment_id: string | null;
          import_external_id: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          storage_path: string;
          file_name: string;
          content_type?: string | null;
          size_bytes: number;
          uploaded_by?: string;
          created_at?: string;
          deleted_at?: string | null;
          source?: string;
          comment_id?: string | null;
          import_external_id?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          storage_path?: string;
          file_name?: string;
          content_type?: string | null;
          size_bytes?: number;
          uploaded_by?: string;
          created_at?: string;
          deleted_at?: string | null;
          source?: string;
          comment_id?: string | null;
          import_external_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_attachments_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_attachments_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      task_field_values: {
        Row: {
          task_id: string;
          field_id: string;
          value: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          task_id: string;
          field_id: string;
          value?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          task_id?: string;
          field_id?: string;
          value?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "task_field_values_field_id_fkey";
            columns: ["field_id"];
            isOneToOne: false;
            referencedRelation: "custom_fields";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_field_values_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      task_followers: {
        Row: {
          task_id: string;
          profile_id: string;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          task_id: string;
          profile_id: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          task_id?: string;
          profile_id?: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_followers_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_followers_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      list_column_widths: {
        Row: {
          id: string;
          profile_id: string;
          project_id: string;
          widths: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          project_id: string;
          widths?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          profile_id?: string;
          project_id?: string;
          widths?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "list_column_widths_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "list_column_widths_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_stars: {
        Row: {
          id: string;
          profile_id: string;
          project_id: string;
          starred_at: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          project_id: string;
          starred_at?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          profile_id?: string;
          project_id?: string;
          starred_at?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_stars_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_stars_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      task_likes: {
        Row: {
          id: string;
          task_id: string;
          profile_id: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          profile_id?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          profile_id?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_likes_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_likes_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      task_projects: {
        Row: {
          task_id: string;
          project_id: string;
          section_id: string | null;
          sort_order: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          task_id: string;
          project_id: string;
          section_id?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          task_id?: string;
          project_id?: string;
          section_id?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_projects_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_projects_section_id_project_id_fkey";
            columns: ["section_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "sections";
            referencedColumns: ["id", "project_id"];
          },
          {
            foreignKeyName: "task_projects_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      task_stories: {
        Row: {
          id: string;
          task_id: string;
          actor_id: string | null;
          kind: string;
          data: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          actor_id?: string | null;
          kind: string;
          data?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          task_id?: string;
          actor_id?: string | null;
          kind?: string;
          data?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "task_stories_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_stories_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      task_templates: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          title: string;
          notes: string | null;
          subtasks: Json;
          field_values: Json;
          assignee_id: string | null;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          kind: string;
          tags: Json;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          title: string;
          notes?: string | null;
          subtasks?: Json;
          field_values?: Json;
          assignee_id?: string | null;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          kind?: string;
          tags?: Json;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          title?: string;
          notes?: string | null;
          subtasks?: Json;
          field_values?: Json;
          assignee_id?: string | null;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          kind?: string;
          tags?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "task_templates_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_templates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_templates_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          id: string;
          workspace_id: string;
          home_project_id: string | null;
          title: string;
          notes: string | null;
          completed_at: string | null;
          assignee_id: string | null;
          due_on: string | null;
          start_on: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          source: string;
          req_project_id: string | null;
          req_number: number | null;
          req_subindex: number | null;
          req_path: string | null;
          req_label: string | null;
          req_period: string;
          req_counter_key: string;
          due_at: string | null;
          start_at: string | null;
          time_zone: string | null;
          recurrence: Json | null;
          recurrence_series_id: string | null;
          recurrence_seq: number;
          recurrence_next_id: string | null;
          assigned_at: string | null;
          kind: string;
          parent_task_id: string | null;
          root_task_id: string | null;
          subtask_order: number;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          home_project_id?: string | null;
          title: string;
          notes?: string | null;
          completed_at?: string | null;
          assignee_id?: string | null;
          due_on?: string | null;
          start_on?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          source?: string;
          req_project_id?: string | null;
          req_number?: number | null;
          req_subindex?: number | null;
          req_path?: string | null;
          req_label?: string | null;
          req_period?: string;
          req_counter_key?: string;
          due_at?: string | null;
          start_at?: string | null;
          time_zone?: string | null;
          recurrence?: Json | null;
          recurrence_series_id?: string | null;
          recurrence_seq?: number;
          recurrence_next_id?: string | null;
          assigned_at?: string | null;
          kind?: string;
          parent_task_id?: string | null;
          root_task_id?: string | null;
          subtask_order?: number;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          home_project_id?: string | null;
          title?: string;
          notes?: string | null;
          completed_at?: string | null;
          assignee_id?: string | null;
          due_on?: string | null;
          start_on?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          source?: string;
          req_project_id?: string | null;
          req_number?: number | null;
          req_subindex?: number | null;
          req_path?: string | null;
          req_label?: string | null;
          req_period?: string;
          req_counter_key?: string;
          due_at?: string | null;
          start_at?: string | null;
          time_zone?: string | null;
          recurrence?: Json | null;
          recurrence_series_id?: string | null;
          recurrence_seq?: number;
          recurrence_next_id?: string | null;
          assigned_at?: string | null;
          kind?: string;
          parent_task_id?: string | null;
          root_task_id?: string | null;
          subtask_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_home_project_id_fkey";
            columns: ["home_project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_parent_task_id_fkey";
            columns: ["parent_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_root_task_id_fkey";
            columns: ["root_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_admins: {
        Row: {
          id: string;
          workspace_id: string;
          profile_id: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          profile_id: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          profile_id?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_admins_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_admins_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_admins_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      goal_links: {
        Row: {
          id: string;
          goal_id: string;
          project_id: string | null;
          portfolio_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          goal_id: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          goal_id?: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "goal_links_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goal_links_goal_id_fkey";
            columns: ["goal_id"];
            isOneToOne: false;
            referencedRelation: "goals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goal_links_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goal_links_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      goal_status_updates: {
        Row: {
          id: string;
          goal_id: string;
          status: string;
          body: string | null;
          author_id: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          goal_id: string;
          status: string;
          body?: string | null;
          author_id?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          goal_id?: string;
          status?: string;
          body?: string | null;
          author_id?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "goal_status_updates_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goal_status_updates_goal_id_fkey";
            columns: ["goal_id"];
            isOneToOne: false;
            referencedRelation: "goals";
            referencedColumns: ["id"];
          },
        ];
      };
      goals: {
        Row: {
          id: string;
          workspace_id: string;
          team_id: string | null;
          parent_id: string | null;
          owner_id: string | null;
          title: string;
          notes: string | null;
          period_start: string | null;
          period_end: string | null;
          status: string;
          progress_mode: string;
          manual_progress: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id?: string;
          team_id?: string | null;
          parent_id?: string | null;
          owner_id?: string | null;
          title: string;
          notes?: string | null;
          period_start?: string | null;
          period_end?: string | null;
          status?: string;
          progress_mode?: string;
          manual_progress?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          team_id?: string | null;
          parent_id?: string | null;
          owner_id?: string | null;
          title?: string;
          notes?: string | null;
          period_start?: string | null;
          period_end?: string | null;
          status?: string;
          progress_mode?: string;
          manual_progress?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "goals_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "goals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      team_members: {
        Row: {
          id: string;
          team_id: string;
          profile_id: string;
          role: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          team_id: string;
          profile_id: string;
          role?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          team_id?: string;
          profile_id?: string;
          role?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "team_members_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_members_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_members_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      team_curated_work: {
        Row: {
          id: string;
          team_id: string;
          project_id: string | null;
          portfolio_id: string | null;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          team_id: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          team_id?: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "team_curated_work_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_curated_work_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_curated_work_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_curated_work_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      team_projects: {
        Row: {
          id: string;
          team_id: string;
          project_id: string;
          role: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          team_id: string;
          project_id: string;
          role: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          team_id?: string;
          project_id?: string;
          role?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "team_projects_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_projects_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_projects_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      teams: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id?: string;
          name: string;
          description?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "teams_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "teams_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workload_capacities: {
        Row: {
          id: string;
          project_id: string | null;
          portfolio_id: string | null;
          profile_id: string;
          weekly_capacity: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          profile_id: string;
          weekly_capacity: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          profile_id?: string;
          weekly_capacity?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "workload_capacities_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workload_capacities_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workload_capacities_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workload_capacities_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_status_updates: {
        Row: {
          id: string;
          project_id: string;
          status: string;
          note: string | null;
          author_id: string | null;
          created_at: string;
          title: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          status: string;
          note?: string | null;
          author_id?: string | null;
          created_at?: string;
          title?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          status?: string;
          note?: string | null;
          author_id?: string | null;
          created_at?: string;
          title?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_status_updates_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_status_updates_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolio_children: {
        Row: {
          id: string;
          parent_id: string;
          child_id: string;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          parent_id: string;
          child_id: string;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          parent_id?: string;
          child_id?: string;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portfolio_children_child_id_fkey";
            columns: ["child_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_children_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_children_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolio_fields: {
        Row: {
          id: string;
          portfolio_id: string;
          name: string;
          field_type: string;
          options: Json;
          sort_order: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          portfolio_id: string;
          name: string;
          field_type: string;
          options?: Json;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          portfolio_id?: string;
          name?: string;
          field_type?: string;
          options?: Json;
          sort_order?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portfolio_fields_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_fields_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
        ];
      };
      portfolio_field_values: {
        Row: {
          id: string;
          portfolio_id: string;
          field_id: string;
          project_id: string;
          value: Json | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          portfolio_id: string;
          field_id: string;
          project_id: string;
          value?: Json | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          portfolio_id?: string;
          field_id?: string;
          project_id?: string;
          value?: Json | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "portfolio_field_values_field_id_fkey";
            columns: ["field_id"];
            isOneToOne: false;
            referencedRelation: "portfolio_fields";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_field_values_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_field_values_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portfolio_field_values_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      tags: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          color: string;
          archived_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id?: string;
          name: string;
          color?: string;
          archived_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          color?: string;
          archived_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "tags_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tags_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      task_tags: {
        Row: {
          id: string;
          task_id: string;
          tag_id: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          tag_id: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          tag_id?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_tags_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      project_messages: {
        Row: {
          id: string;
          project_id: string;
          thread_id: string | null;
          title: string | null;
          body: string;
          author_id: string;
          edited_at: string | null;
          last_activity_at: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          thread_id?: string | null;
          title?: string | null;
          body: string;
          author_id?: string;
          edited_at?: string | null;
          last_activity_at?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          thread_id?: string | null;
          title?: string | null;
          body?: string;
          author_id?: string;
          edited_at?: string | null;
          last_activity_at?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_messages_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_messages_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "project_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_messages_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      project_message_mentions: {
        Row: {
          message_id: string;
          profile_id: string;
          created_at: string;
        };
        Insert: {
          message_id: string;
          profile_id: string;
          created_at?: string;
        };
        Update: {
          message_id?: string;
          profile_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_message_mentions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "project_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_message_mentions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      project_message_reactions: {
        Row: {
          id: string;
          message_id: string;
          project_id: string;
          profile_id: string;
          emoji: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          message_id: string;
          project_id?: string;
          profile_id?: string;
          emoji: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          message_id?: string;
          project_id?: string;
          profile_id?: string;
          emoji?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_message_reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "project_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_message_reactions_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      tag_field_migrations: {
        Row: {
          field_id: string;
          tags_created: number;
          links_created: number;
          migrated_at: string;
        };
        Insert: {
          field_id: string;
          tags_created?: number;
          links_created?: number;
          migrated_at?: string;
        };
        Update: {
          field_id?: string;
          tags_created?: number;
          links_created?: number;
          migrated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tag_field_migrations_field_id_fkey";
            columns: ["field_id"];
            isOneToOne: false;
            referencedRelation: "custom_fields";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          default_team_id: string | null;
          logo_path: string | null;
          email_sender_name: string | null;
          allow_commenter_role: boolean;
          work_week: number[];
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          default_team_id?: string | null;
          logo_path?: string | null;
          email_sender_name?: string | null;
          allow_commenter_role?: boolean;
          work_week?: number[];
        };
        Update: {
          id?: string;
          name?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          default_team_id?: string | null;
          logo_path?: string | null;
          email_sender_name?: string | null;
          allow_commenter_role?: boolean;
          work_week?: number[];
        };
        Relationships: [
          {
            foreignKeyName: "workspaces_default_team_id_fkey";
            columns: ["default_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      pending_memberships: {
        Row: {
          id: string;
          workspace_id: string;
          email: string;
          project_id: string | null;
          portfolio_id: string | null;
          team_id: string | null;
          role: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          applied_at: string | null;
          applied_profile_id: string | null;
          deleted_at: string | null;
          resent_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          email: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          team_id?: string | null;
          role: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          applied_at?: string | null;
          applied_profile_id?: string | null;
          deleted_at?: string | null;
          resent_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          email?: string;
          project_id?: string | null;
          portfolio_id?: string | null;
          team_id?: string | null;
          role?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          applied_at?: string | null;
          applied_profile_id?: string | null;
          deleted_at?: string | null;
          resent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "pending_memberships_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pending_memberships_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pending_memberships_portfolio_id_fkey";
            columns: ["portfolio_id"];
            isOneToOne: false;
            referencedRelation: "portfolios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pending_memberships_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
      };
      team_messages: {
        Row: {
          id: string;
          team_id: string;
          thread_id: string | null;
          title: string | null;
          body: string;
          author_id: string;
          edited_at: string | null;
          last_activity_at: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          team_id: string;
          thread_id?: string | null;
          title?: string | null;
          body: string;
          author_id?: string;
          edited_at?: string | null;
          last_activity_at?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          team_id?: string;
          thread_id?: string | null;
          title?: string | null;
          body?: string;
          author_id?: string;
          edited_at?: string | null;
          last_activity_at?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "team_messages_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_messages_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "team_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_messages_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      team_message_mentions: {
        Row: { message_id: string; profile_id: string; created_at: string };
        Insert: { message_id: string; profile_id: string; created_at?: string };
        Update: { message_id?: string; profile_id?: string; created_at?: string };
        Relationships: [
          {
            foreignKeyName: "team_message_mentions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "team_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_message_mentions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      team_message_reactions: {
        Row: {
          id: string;
          message_id: string;
          team_id: string;
          profile_id: string;
          emoji: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          message_id: string;
          team_id?: string;
          profile_id?: string;
          emoji: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          message_id?: string;
          team_id?: string;
          profile_id?: string;
          emoji?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "team_message_reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "team_messages";
            referencedColumns: ["id"];
          },
        ];
      };
      team_message_followers: {
        Row: {
          id: string;
          thread_id: string;
          team_id: string;
          profile_id: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          thread_id: string;
          team_id?: string;
          profile_id?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          thread_id?: string;
          team_id?: string;
          profile_id?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "team_message_followers_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "team_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_message_followers_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notification_settings: {
        Row: {
          profile_id: string;
          kind: string;
          inbox: boolean | null;
          email: boolean | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          profile_id?: string;
          kind: string;
          inbox?: boolean | null;
          email?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          profile_id?: string;
          kind?: string;
          inbox?: boolean | null;
          email?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      email_suppressions: {
        Row: {
          id: string;
          email: string;
          reason: string;
          detail: string | null;
          email_kind: string | null;
          outbox_id: string | null;
          created_at: string;
          updated_at: string;
          cleared_at: string | null;
          cleared_by: string | null;
        };
        Insert: {
          id?: string;
          email: string;
          reason: string;
          detail?: string | null;
          email_kind?: string | null;
          outbox_id?: string | null;
          created_at?: string;
          updated_at?: string;
          cleared_at?: string | null;
          cleared_by?: string | null;
        };
        Update: {
          id?: string;
          email?: string;
          reason?: string;
          detail?: string | null;
          email_kind?: string | null;
          outbox_id?: string | null;
          created_at?: string;
          updated_at?: string;
          cleared_at?: string | null;
          cleared_by?: string | null;
        };
        Relationships: [];
      };
      email_preferences: {
        Row: {
          profile_id: string;
          digest: string;
          digest_hour: number;
          digest_weekday: number;
          time_zone: string;
          report_emails: boolean;
          unsubscribe_token: string;
          digest_next_at: string | null;
          digest_last_sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          profile_id?: string;
          digest?: string;
          digest_hour?: number;
          digest_weekday?: number;
          time_zone?: string;
          report_emails?: boolean;
          unsubscribe_token?: string;
          digest_next_at?: string | null;
          digest_last_sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          profile_id?: string;
          digest?: string;
          digest_hour?: number;
          digest_weekday?: number;
          time_zone?: string;
          report_emails?: boolean;
          unsubscribe_token?: string;
          digest_next_at?: string | null;
          digest_last_sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      report_schedules: {
        Row: {
          id: string;
          workspace_id: string;
          owner_id: string;
          name: string;
          report: string;
          filters: Json;
          frequency: string;
          weekday: number;
          month_day: number;
          send_hour: number;
          time_zone: string;
          recipients: string[];
          paused_at: string | null;
          next_run_at: string | null;
          last_run_at: string | null;
          last_sent_at: string | null;
          last_sent_count: number | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id?: string;
          owner_id?: string;
          name: string;
          report?: string;
          filters?: Json;
          frequency: string;
          weekday?: number;
          month_day?: number;
          send_hour?: number;
          time_zone?: string;
          recipients: string[];
          paused_at?: string | null;
          next_run_at?: string | null;
          last_run_at?: string | null;
          last_sent_at?: string | null;
          last_sent_count?: number | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          owner_id?: string;
          name?: string;
          report?: string;
          filters?: Json;
          frequency?: string;
          weekday?: number;
          month_day?: number;
          send_hour?: number;
          time_zone?: string;
          recipients?: string[];
          paused_at?: string | null;
          next_run_at?: string | null;
          last_run_at?: string | null;
          last_sent_at?: string | null;
          last_sent_count?: number | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      project_status_templates: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          status: string | null;
          title: string | null;
          sections: Json;
          sort_order: number;
          created_by: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          status?: string | null;
          title?: string | null;
          sections?: Json;
          sort_order?: number;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          status?: string | null;
          title?: string | null;
          sections?: Json;
          sort_order?: number;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      calendar_feeds: {
        Row: {
          id: string;
          profile_id: string;
          scope: string;
          project_id: string | null;
          team_id: string | null;
          token_hint: string;
          token_rotated_at: string;
          last_fetched_at: string | null;
          created_at: string;
          updated_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id?: string;
          scope: string;
          project_id?: string | null;
          team_id?: string | null;
          token_hint?: string;
          token_rotated_at?: string;
          last_fetched_at?: string | null;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          profile_id?: string;
          scope?: string;
          project_id?: string | null;
          team_id?: string | null;
          token_hint?: string;
          token_rotated_at?: string;
          last_fetched_at?: string | null;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_calendar_feed: {
        Args: { feed_scope: string; target?: string | null };
        Returns: Json;
      };
      rotate_calendar_feed: {
        Args: { target_feed: string };
        Returns: Json;
      };
      calendar_feed: {
        Args: { feed_token: string };
        Returns: Json;
      };
      status_template_summary: {
        Args: { sections: Json };
        Returns: string;
      };
      filter_project_task_ids: {
        Args: { target_project: string; filters?: Json; tz?: string };
        Returns: string[];
      };
      report_overdue_tasks_after: {
        Args: {
          filters?: Json;
          tz?: string;
          after_due?: string | null;
          after_title?: string | null;
          after_task?: string | null;
          max_results?: number;
        };
        Returns: Json;
      };
      list_workspace_email_deliveries: {
        Args: { max_results?: number };
        Returns: {
          id: string;
          kind: string;
          recipient: string;
          in_workspace: boolean;
          status: string;
          delivery_status: string | null;
          delivery_detail: string | null;
          attempts: number;
          max_attempts: number;
          last_error: string | null;
          created_at: string;
          sent_at: string | null;
          delivery_event_at: string | null;
          suppressed: boolean;
        }[];
      };
      workspace_email_summary: {
        Args: { window_days?: number };
        Returns: {
          sent: number;
          delivered: number;
          delayed: number;
          bounced: number;
          complained: number;
          failed: number;
          waiting: number;
          suppressed_addresses: number;
        }[];
      };
      list_email_suppressions: {
        Args: Record<PropertyKey, never>;
        Returns: {
          id: string;
          email: string;
          in_workspace: boolean;
          reason: string;
          detail: string | null;
          email_kind: string | null;
          created_at: string;
        }[];
      };
      clear_email_suppression: {
        Args: { target_suppression: string };
        Returns: undefined;
      };
      set_email_digest: {
        Args: { frequency: string; send_hour: number; send_weekday: number; zone: string };
        Returns: string | null;
      };
      set_report_emails: {
        Args: { enabled: boolean };
        Returns: undefined;
      };
      email_unsubscribe: {
        Args: { unsubscribe_token: string; what: string };
        Returns: Json;
      };
      record_email_event: {
        Args: {
          provider_email_id: string;
          event_type: string;
          event_time?: string | null;
          bounce_type?: string | null;
          bounce_subtype?: string | null;
        };
        Returns: Json;
      };
      digest_email_items: {
        Args: { target_email: string };
        Returns: { item_id: string; kind: string; data: Json; created_at: string; parts: Json }[];
      };
      claim_scheduled_emails: {
        Args: { max_items?: number; only_id?: string | null };
        Returns: Database["public"]["Tables"]["email_outbox"]["Row"][];
      };
      alhc_queue_scheduled_emails: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      add_portfolio_member: {
        Args: { target_portfolio: string; member_email: string; member_role?: string };
        Returns: string | null;
      };
      invite_to_workspace: {
        Args: { member_email: string };
        Returns: Json;
      };
      resend_workspace_invite: {
        Args: { member_email: string };
        Returns: string;
      };
      remove_workspace_member: {
        Args: { member_email: string };
        Returns: undefined;
      };
      browse_projects: {
        Args: { target_team?: string | null };
        Returns: {
          project_id: string;
          name: string;
          description: string | null;
          team_id: string;
          team_name: string;
          visibility: string;
          status: string;
          archived: boolean;
          member_count: number;
          my_role: string | null;
        }[];
      };
      join_project: {
        Args: { target_project: string };
        Returns: string;
      };
      add_portfolio_project: {
        Args: { target_portfolio: string; target_project: string };
        Returns: string;
      };
      add_project_member: {
        Args: { target_project: string; member_email: string; member_role?: string };
        Returns: string | null;
      };
      add_workspace_admin: {
        Args: { target_workspace: string | null; member_email: string };
        Returns: string;
      };
      add_task_dependency: {
        Args: { predecessor: string; successor: string };
        Returns: string;
      };
      apply_task_numbering: {
        Args: { target_project: string; settings?: Json; mode: string };
        Returns: Json;
      };
      assign_request_number: {
        Args: { target_task: string };
        Returns: string;
      };
      bulk_update_tasks: {
        Args: { target_tasks: string[]; operation: Json };
        Returns: Json;
      };
      cancel_approval: {
        Args: { target_approval: string };
        Returns: undefined;
      };
      cancel_integration_delivery: {
        Args: { target_delivery: string };
        Returns: Json;
      };
      claim_email_deliveries: {
        Args: { max_items?: number; only_id?: string | null };
        Returns: Database["public"]["Tables"]["email_outbox"]["Row"][];
      };
      claim_email_outbox: {
        Args: { max_items?: number; only_id?: string | null };
        Returns: Database["public"]["Tables"]["email_outbox"]["Row"][];
      };
      complete_email_outbox: {
        Args: { target_email: string; outcome: string; message_id?: string | null; error_message?: string | null };
        Returns: undefined;
      };
      claim_integration_outbox: {
        Args: { max_items?: number; only_id?: string | null };
        Returns: Database["public"]["Tables"]["integration_outbox"]["Row"][];
      };
      complete_integration_outbox: {
        Args: { target_item: string; outcome: string; response?: Json | null; error_message?: string | null };
        Returns: undefined;
      };
      create_task: {
        Args: { target_project: string; target_section: string | null; task_title: string };
        Returns: string;
      };
      decide_approval: {
        Args: { target_approval: string; decision: string; decision_note?: string | null };
        Returns: undefined;
      };
      filter_project_tasks: {
        Args: { target_project: string; filters?: Json; tz?: string };
        Returns: {
          task_id: string;
          section_id: string | null;
          assignee_id: string | null;
          due_on: string | null;
          completed_at: string | null;
        }[];
      };
      format_request_label: {
        Args: { target_project: string; number: number };
        Returns: string;
      };
      finish_import_run: {
        Args: { target_run: string; run_status: string; run_summary?: Json };
        Returns: undefined;
      };
      get_project_integrations: {
        Args: { target_project: string };
        Returns: Json;
      };
      get_public_form: {
        Args: { target_form: string };
        Returns: Json;
      };
      has_portfolio_role: {
        Args: { target_portfolio: string; min_role: string };
        Returns: boolean;
      };
      has_project_role: {
        Args: { target_project: string; min_role: string };
        Returns: boolean;
      };
      has_task_role: {
        Args: { target_task: string; min_role: string };
        Returns: boolean;
      };
      install_rule_preset: {
        Args: { target_project: string; preset: string; inputs?: Json; enable?: boolean };
        Returns: string[];
      };
      is_allowlisted: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      is_workspace_admin: {
        Args: { target_workspace?: string | null };
        Returns: boolean;
      };
      import_batch: {
        Args: { target_run: string; batch: Json };
        Returns: Json;
      };
      import_lookup: {
        Args: { import_source: string; external_ids: string[] };
        Returns: { project_id: string; kind: string; external_id: string }[];
      };
      list_field_library: {
        Args: Record<PropertyKey, never>;
        Returns: { field_id: string; name: string; field_type: string; description: string | null; options: Json }[];
      };
      list_member_last_activity: {
        Args: { target_profile?: string | null };
        Returns: { profile_id: string; email: string; last_sign_in_at: string | null; last_active_at: string | null }[];
      };
      set_notification_setting: {
        Args: { category: string; channel: string; enabled: boolean };
        Returns: undefined;
      };
      can_post_team_message: {
        Args: { target_team: string };
        Returns: boolean;
      };
      claim_notification_emails: {
        Args: { max_items?: number; only_id?: string | null };
        Returns: Database["public"]["Tables"]["email_outbox"]["Row"][];
      };
      list_workspace_member_activity: {
        Args: Record<PropertyKey, never>;
        Returns: { email: string; last_sign_in_at: string | null }[];
      };
      browse_project_people: {
        Args: { target_team?: string | null };
        Returns: { project_id: string; owner_ids: string[]; member_ids: string[]; modified_at: string | null }[];
      };
      list_email_deliveries: {
        Args: { target_project: string; max_results?: number };
        Returns: {
          id: string;
          kind: string;
          recipient: string;
          task_id: string;
          task_title: string | null;
          rule_id: string | null;
          rule_name: string | null;
          status: string;
          attempts: number;
          max_attempts: number;
          last_error: string | null;
          next_attempt_at: string | null;
          sent_at: string | null;
          created_at: string;
          updated_at: string;
        }[];
      };
      list_integration_deliveries: {
        Args: { target_project: string; max_results?: number };
        Returns: {
          id: string;
          channel: string;
          task_id: string | null;
          task_title: string | null;
          rule_id: string | null;
          rule_name: string | null;
          target_hint: string;
          status: string;
          attempts: number;
          max_attempts: number;
          response_status: number | null;
          last_error: string | null;
          signed: boolean;
          next_attempt_at: string | null;
          sent_at: string | null;
          created_at: string;
          updated_at: string;
        }[];
      };
      list_portfolio_progress: {
        Args: Record<PropertyKey, never>;
        Returns: { portfolio_id: string; task_count: number; completed_count: number }[];
      };
      move_portfolio_project: {
        Args: { target_portfolio: string; target_project: string; new_sort_order: number };
        Returns: undefined;
      };
      normalize_recurrence: {
        Args: { rule: Json };
        Returns: Json | null;
      };
      open_blocker_count: {
        Args: { target_task: string };
        Returns: number;
      };
      all_projects_report: {
        Args: { tz?: string };
        Returns: {
          project_id: string;
          name: string;
          status: string;
          status_note: string | null;
          status_updated_at: string | null;
          task_count: number;
          completed_count: number;
          incomplete_count: number;
          overdue_count: number;
          completed_recent_count: number;
        }[];
      };
      report_completed_series: {
        Args: { filters?: Json; bucket_interval?: string; tz?: string };
        Returns: { bucket_start: string; completed_count: number }[];
      };
      report_overdue_tasks: {
        Args: { filters?: Json; tz?: string; max_results?: number };
        Returns: {
          task_id: string;
          title: string;
          project_id: string;
          assignee_id: string | null;
          due_on: string;
          days_overdue: number;
          parent_task_id: string | null;
        }[];
      };
      report_task_rows: {
        Args: { filters?: Json; tz?: string };
        Returns: {
          project_id: string;
          task_id: string;
          section_id: string | null;
          assignee_id: string | null;
          due_on: string | null;
          completed_at: string | null;
          is_subtask: boolean;
        }[];
      };
      workspace_hidden_project_count: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      workspace_report: {
        Args: { filters?: Json; group_by?: string; tz?: string };
        Returns: {
          bucket: string | null;
          project_id: string | null;
          task_count: number;
          completed_count: number;
          incomplete_count: number;
          overdue_count: number;
          completed_recent_count: number;
        }[];
      };
      ensure_my_task_sections: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      my_tasks_layout: {
        Args: Record<PropertyKey, never>;
        Returns: { task_id: string; section_id: string; sort_order: number }[];
      };
      place_my_task: {
        Args: { target_task: string; target_section: string; before_task: string | null };
        Returns: number;
      };
      place_my_task_section: {
        Args: { target_section: string; before_section: string | null };
        Returns: number;
      };
      move_my_tasks: {
        Args: { target_tasks: string[]; target_section: string };
        Returns: Json;
      };
      create_inbound_endpoint: {
        Args: {
          target_project: string;
          endpoint_name: string;
          target_section?: string | null;
          default_assignee?: string | null;
          default_tags?: string[];
          with_signing_secret?: boolean;
        };
        Returns: Json;
      };
      receive_inbound_webhook: {
        Args: {
          endpoint_token: string;
          raw_body: string;
          request_timestamp?: string | null;
          request_signature?: string | null;
          idempotency_key?: string | null;
        };
        Returns: Json;
      };
      rotate_inbound_token: {
        Args: { target_endpoint: string };
        Returns: Json;
      };
      set_inbound_signing_secret: {
        Args: { target_endpoint: string; enable: boolean };
        Returns: Json;
      };
      retry_email_delivery: {
        Args: { target_email: string };
        Returns: string;
      };
      email_reply_token: {
        Args: { target_email: string };
        Returns: string | null;
      };
      post_submitter_reply: {
        Args: { reply_token: string; sender_email: string; reply_body: string; provider_email_id?: string | null };
        Returns: Json;
      };
      resolve_email_design: {
        Args: { design_kind: string; target_project?: string | null; target_form?: string | null };
        Returns: Json;
      };
      email_design_context: {
        Args: { target_email: string };
        Returns: Json;
      };
      can_edit_email_design: {
        Args: { target_workspace: string; target_project: string | null };
        Returns: boolean;
      };
      set_submitter_thread_closed: {
        Args: { target_task: string; closed: boolean };
        Returns: Json;
      };
      submitter_thread_status: {
        Args: { target_task: string };
        Returns: Json;
      };
      attach_reply_file: {
        Args: { target_comment: string; file_path: string; file_name: string; file_type: string | null; file_size: number };
        Returns: string;
      };
      note_reply_skipped_files: {
        Args: { target_comment: string; files: Json };
        Returns: undefined;
      };
      commenter_role_allowed: {
        Args: { target_workspace: string };
        Returns: boolean;
      };
      list_commenter_members: {
        Args: Record<PropertyKey, never>;
        Returns: { profile_id: string; full_name: string | null; email: string; project_count: number; projects: Json }[];
      };
      convert_commenter_members: {
        Args: { target_profile: string; new_role: string };
        Returns: number;
      };
      import_attachment_targets: {
        Args: { target_run: string; attachment_refs: Json };
        Returns: { attachment_gid: string; task_id: string; present: boolean }[];
      };
      import_attachment_file: {
        Args: {
          target_run: string;
          target_task: string;
          attachment_gid: string;
          file_path: string;
          file_name: string;
          file_type: string | null;
          file_size: number;
        };
        Returns: string;
      };
      send_submitter_response: {
        Args: { target_task: string; response_body: string };
        Returns: string;
      };
      submitter_reply_token: {
        Args: { target_email: string };
        Returns: string | null;
      };
      post_email_reply: {
        Args: { reply_token: string; sender_email: string; reply_body: string; provider_email_id?: string | null };
        Returns: Json;
      };
      post_email_forward: {
        Args: {
          forward_token: string;
          sender_email: string;
          sender_verified: boolean;
          email_subject: string;
          email_body: string;
          provider_email_id?: string | null;
        };
        Returns: Json;
      };
      attach_forwarded_file: {
        Args: { target_forward: string; file_path: string; file_name: string; file_type: string | null; file_size: number };
        Returns: string;
      };
      my_forwarding_address: {
        Args: Record<PropertyKey, never>;
        Returns: Database["public"]["Tables"]["email_forwarding_addresses"]["Row"];
      };
      rotate_forwarding_address: {
        Args: Record<PropertyKey, never>;
        Returns: Database["public"]["Tables"]["email_forwarding_addresses"]["Row"];
      };
      list_stale_form_uploads: {
        Args: { max_items?: number };
        Returns: string[];
      };
      post_project_status_update: {
        Args: { target_project: string; new_status: string; update_title?: string | null; summary?: string | null };
        Returns: undefined;
      };
      task_comment_counts: {
        Args: { task_ids: string[] };
        Returns: { task_id: string; comment_count: number }[];
      };
      project_task_cards: {
        Args: { target_project: string; only_ids?: string[] | null };
        Returns: Json;
      };
      project_schedule_cards: {
        Args: {
          target_project: string;
          filters?: Json;
          tz?: string;
          range_start?: string | null;
          range_end?: string | null;
          schedule?: string;
        };
        Returns: Json;
      };
      project_task_card_page: {
        Args: {
          target_project: string;
          filters?: Json;
          tz?: string;
          group_by?: string;
          sorts?: Json;
          page_size?: number;
          limits?: Json;
        };
        Returns: Json;
      };
      my_task_cards: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      inbox_page: {
        Args: { inbox_tab: string };
        Returns: Json;
      };
      inbox_unread_count: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      project_section_task_counts: {
        Args: { target_project: string };
        Returns: Json;
      };
      task_comment_page: {
        Args: {
          target_task: string;
          before_at?: string | null;
          before_id?: string | null;
          max_results?: number;
        };
        Returns: Json;
      };
      retry_integration_delivery: {
        Args: { target_delivery: string };
        Returns: Json;
      };
      project_workload: {
        Args: { target_project: string; range_start?: string | null; range_end?: string | null; value_field?: string | null };
        Returns: {
          task_id: string;
          title: string;
          assignee_id: string;
          start_on: string | null;
          due_on: string;
          value: number | null;
          project_id: string;
          can_edit: boolean;
        }[];
      };
      portfolio_workload: {
        Args: {
          target_portfolio: string;
          range_start?: string | null;
          range_end?: string | null;
          value_field_name?: string | null;
        };
        Returns: {
          task_id: string;
          title: string;
          assignee_id: string;
          start_on: string | null;
          due_on: string;
          value: number | null;
          project_id: string;
          can_edit: boolean;
        }[];
      };
      add_team_member: {
        Args: { target_team: string; member_email: string; member_role?: string };
        Returns: string | null;
      };
      update_team_member_role: {
        Args: { target_team: string; target_profile: string; new_role: string };
        Returns: undefined;
      };
      remove_team_member: {
        Args: { target_team: string; target_profile: string };
        Returns: undefined;
      };
      add_team_to_project: {
        Args: { target_project: string; target_team: string; member_role?: string };
        Returns: Json;
      };
      is_team_lead: {
        Args: { target_team: string };
        Returns: boolean;
      };
      can_manage_team: {
        Args: { target_team: string };
        Returns: boolean;
      };
      can_curate_team: {
        Args: { target_team: string };
        Returns: boolean;
      };
      can_edit_goal: {
        Args: { target_goal: string };
        Returns: boolean;
      };
      goal_editable: {
        Args: { goal_owner: string | null; goal_team: string | null; goal_workspace: string };
        Returns: boolean;
      };
      goal_hidden_project_count: {
        Args: { target_goal: string };
        Returns: number;
      };
      goal_task_counts: {
        Args: { target_goal: string };
        Returns: { task_count: number; completed_count: number }[];
      };
      goal_progress: {
        Args: { target_workspace?: string | null };
        Returns: {
          goal_id: string;
          progress: number | null;
          task_count: number | null;
          completed_count: number | null;
          hidden_project_count: number;
          sub_goal_count: number;
        }[];
      };
      oldest_workspace_id: {
        Args: Record<PropertyKey, never>;
        Returns: string | null;
      };
      profile_in_workspace: {
        Args: { target_profile: string };
        Returns: boolean;
      };
      set_workload_capacity: {
        Args: {
          target_project: string | null;
          target_portfolio: string | null;
          target_profile: string;
          new_capacity: number | null;
        };
        Returns: undefined;
      };
      place_section: {
        Args: { target_section: string; before_section: string | null };
        Returns: number;
      };
      place_task: {
        Args: { target_task: string; target_project: string; target_section: string | null; before_task: string | null };
        Returns: number;
      };
      portfolio_hidden_project_count: {
        Args: { target_portfolio: string };
        Returns: number;
      };
      portfolio_report: {
        Args: { target_portfolio: string; group_by?: string; tz?: string };
        Returns: {
          bucket: string | null;
          task_count: number;
          completed_count: number;
          incomplete_count: number;
          overdue_count: number;
          completed_recent_count: number;
        }[];
      };
      portfolio_role: {
        Args: { target_portfolio: string };
        Returns: string | null;
      };
      project_metrics: {
        Args: { target_project: string; filters?: Json; group_by?: string; tz?: string };
        Returns: { bucket: string | null; task_count: number }[];
      };
      project_role: {
        Args: { target_project: string };
        Returns: string | null;
      };
      reindex_section_order: {
        Args: { target_project: string };
        Returns: number;
      };
      reindex_task_order: {
        Args: { target_project: string; target_section: string | null };
        Returns: number;
      };
      remove_portfolio_member: {
        Args: { target_portfolio: string; target_profile: string };
        Returns: undefined;
      };
      remove_portfolio_project: {
        Args: { target_portfolio: string; target_project: string };
        Returns: undefined;
      };
      remove_workspace_admin: {
        Args: { target_workspace: string | null; target_profile: string };
        Returns: undefined;
      };
      remove_project_member: {
        Args: { target_project: string; target_profile: string };
        Returns: undefined;
      };
      recurrence_next_date: {
        Args: { rule: Json; anchor: string };
        Returns: string;
      };
      remove_task_dependency: {
        Args: { target_dependency: string };
        Returns: undefined;
      };
      request_approval: {
        Args: {
          target_task: string;
          approver: string;
          approval_note?: string | null;
          as_subtask?: boolean;
          subtask_title?: string | null;
        };
        Returns: string;
      };
      restore_task: {
        Args: { target_task: string };
        Returns: undefined;
      };
      run_manual_rule: {
        Args: { target_rule: string; target_task: string };
        Returns: Json;
      };
      test_rule: {
        Args: { target_rule: string | null; target_task: string; draft?: Json | null };
        Returns: Json;
      };
      automations_v3_ready: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      rule_run_stats: {
        Args: { rule_ids: string[] };
        Returns: { rule_id: string; last_run_at: string | null; last_status: string | null; runs_7d: number; failures_7d: number }[];
      };
      rule_add_days: {
        Args: { start_on: string; days: number; business: boolean; work_week: number[] };
        Returns: string;
      };
      resubmit_approval: {
        Args: { target_approval: string; approval_note?: string | null };
        Returns: undefined;
      };
      search_tasks: {
        Args: { query: string; max_results?: number };
        Returns: {
          id: string;
          title: string;
          notes: string | null;
          completed_at: string | null;
          due_on: string | null;
          assignee_id: string | null;
          home_project_id: string | null;
          home_project_name: string | null;
        }[];
      };
      set_project_integration: {
        Args: { target_project: string; setting: string; new_value: string | null };
        Returns: Json;
      };
      set_project_status: {
        Args: { target_project: string; new_status: string; note?: string | null };
        Returns: undefined;
      };
      start_import_run: {
        Args: { target_project: string; import_source: string; file_names?: string[] };
        Returns: string;
      };
      submit_form: {
        Args: { target_form: string; submitter_email: string; answers: Json };
        Returns: Json;
      };
      task_request_label: {
        Args: { target_task: string };
        Returns: string | null;
      };
      task_request_display_label: {
        Args: { target_task: string };
        Returns: string | null;
      };
      task_request_labels: {
        Args: { task_ids: string[] };
        Returns: Json;
      };
      request_display_label: {
        Args: { label: string | null; wrap: boolean | null };
        Returns: string | null;
      };
      task_role: {
        Args: { target_task: string };
        Returns: string | null;
      };
      transfer_portfolio_ownership: {
        Args: { target_portfolio: string; target_profile: string };
        Returns: undefined;
      };
      transfer_project_ownership: {
        Args: { target_project: string; target_profile: string };
        Returns: undefined;
      };
      update_portfolio_member_role: {
        Args: { target_portfolio: string; target_profile: string; new_role: string };
        Returns: undefined;
      };
      update_project_member_role: {
        Args: { target_project: string; target_profile: string; new_role: string };
        Returns: undefined;
      };
      workflow_tick: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      can_manage_tag: {
        Args: { target_tag: string };
        Returns: boolean;
      };
      can_manage_project_template: {
        Args: { target_template: string };
        Returns: boolean;
      };
      create_project_from_template: {
        Args: { target_template: string; project_name: string; start_on?: string | null };
        Returns: Json;
      };
      create_subtask: {
        Args: { parent_task: string; task_title: string; before_task?: string | null };
        Returns: string;
      };
      place_subtask: {
        Args: { target_task: string; before_task?: string | null; new_parent?: string | null };
        Returns: undefined;
      };
      create_task_from_template: {
        Args: { target_template: string; target_section?: string | null; task_title?: string | null };
        Returns: string;
      };
      delete_project_template: {
        Args: { target_template: string };
        Returns: undefined;
      };
      duplicate_project: {
        Args: { source_project: string; project_name: string; options?: Json };
        Returns: Json;
      };
      save_project_as_template: {
        Args: {
          source_project: string;
          template_name: string;
          template_description?: string | null;
          anchor_on?: string | null;
          replace_template?: string | null;
        };
        Returns: string;
      };
      save_task_as_template: {
        Args: { target_task: string; target_project: string; template_name: string; include_assignee?: boolean };
        Returns: string;
      };
      update_project_template: {
        Args: { target_template: string; template_name: string; template_description?: string | null };
        Returns: undefined;
      };
      set_task_dependency: {
        Args: { predecessor: string; successor: string; dependency_kind?: string; dependency_lag?: number };
        Returns: string;
      };
      project_dependencies: {
        Args: { target_project: string };
        Returns: { id: string; predecessor_id: string; successor_id: string; kind: string; lag_days: number }[];
      };
      preview_dependency_shift: {
        Args: { target_task: string; new_start_on: string | null; new_due_on: string | null };
        Returns: {
          task_id: string;
          title: string;
          start_on: string | null;
          due_on: string | null;
          new_start: string | null;
          new_due: string | null;
          shift_days: number;
          status: string;
          reason: string | null;
        }[];
      };
      apply_dependency_shift: {
        Args: {
          target_task: string;
          new_start_on: string | null;
          new_due_on: string | null;
          confirmed_tasks?: string[];
        };
        Returns: Json;
      };
      undo_dependency_shift: {
        Args: { changes: Json };
        Returns: Json;
      };
      preview_dependency_shifts: {
        Args: { moves: Json; pull_earlier?: boolean };
        Returns: {
          task_id: string;
          title: string;
          start_on: string | null;
          due_on: string | null;
          new_start: string | null;
          new_due: string | null;
          shift_days: number;
          status: string;
          reason: string | null;
        }[];
      };
      apply_dependency_shifts: {
        Args: { moves: Json; confirmed_tasks?: string[]; pull_earlier?: boolean };
        Returns: Json;
      };
      create_private_task: {
        Args: { task_title: string };
        Returns: string;
      };
      duplicate_task: {
        Args: { target_task: string; options?: Json };
        Returns: Json;
      };
      set_list_column_widths: {
        Args: { target_project: string; new_widths: Json };
        Returns: Json;
      };
      set_project_starred: {
        Args: { target_project: string; starred: boolean };
        Returns: boolean;
      };
      set_project_archived: {
        Args: { target_project: string; archive: boolean };
        Returns: string | null;
      };
      convert_to_subtask: {
        Args: { target_task: string; new_parent: string };
        Returns: undefined;
      };
      convert_to_task: {
        Args: { target_task: string; target_project?: string | null; target_section?: string | null };
        Returns: undefined;
      };
      project_critical_path: {
        Args: { target_project: string };
        Returns: {
          task_id: string;
          start_on: string | null;
          due_on: string | null;
          slack_days: number | null;
          critical: boolean;
          skipped: boolean;
        }[];
      };
      add_portfolio_child: {
        Args: { target_portfolio: string; child_portfolio: string };
        Returns: string;
      };
      remove_portfolio_child: {
        Args: { target_portfolio: string; child_portfolio: string };
        Returns: undefined;
      };
      portfolio_tree: {
        Args: { target_portfolio: string };
        Returns: { portfolio_id: string; group_id: string | null; depth: number }[];
      };
      portfolio_rollup_projects: {
        Args: { target_portfolio: string };
        Returns: {
          project_id: string;
          name: string;
          status: string;
          status_note: string | null;
          status_updated_at: string | null;
          portfolio_id: string;
          group_id: string | null;
          depth: number;
          sort_order: number;
        }[];
      };
      portfolio_timeline: {
        Args: { target_portfolio: string };
        Returns: {
          project_id: string;
          name: string;
          status: string;
          status_note: string | null;
          portfolio_id: string;
          group_id: string | null;
          sort_order: number;
          start_on: string | null;
          due_on: string | null;
          open_task_count: number;
        }[];
      };
      portfolio_milestones: {
        Args: { target_portfolio: string };
        Returns: {
          project_id: string;
          task_id: string;
          title: string;
          due_on: string;
        }[];
      };
      set_portfolio_field_value: {
        Args: { target_field: string; target_project: string; new_value: Json };
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicTables = Database["public"]["Tables"];

export type Tables<T extends keyof PublicTables> = PublicTables[T]["Row"];
export type TablesInsert<T extends keyof PublicTables> = PublicTables[T]["Insert"];
export type TablesUpdate<T extends keyof PublicTables> = PublicTables[T]["Update"];
