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
        };
        Insert: {
          email: string;
          note?: string | null;
          created_at?: string;
        };
        Update: {
          email?: string;
          note?: string | null;
          created_at?: string;
        };
        Relationships: [];
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
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          field_type?: string;
          options?: Json;
          bound_to_sections?: boolean;
          show_in_views?: boolean;
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
      inbox_items: {
        Row: {
          id: string;
          recipient_id: string;
          actor_id: string | null;
          task_id: string | null;
          message_id: string | null;
          comment_id: string | null;
          kind: string;
          read_at: string | null;
          archived_at: string | null;
          created_at: string;
          data: Json;
        };
        Insert: {
          id?: string;
          recipient_id: string;
          actor_id?: string | null;
          task_id?: string | null;
          message_id?: string | null;
          comment_id?: string | null;
          kind: string;
          read_at?: string | null;
          archived_at?: string | null;
          created_at?: string;
          data?: Json;
        };
        Update: {
          id?: string;
          recipient_id?: string;
          actor_id?: string | null;
          task_id?: string | null;
          message_id?: string | null;
          comment_id?: string | null;
          kind?: string;
          read_at?: string | null;
          archived_at?: string | null;
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
        };
        Relationships: [];
      };
      integration_secrets: {
        Row: {
          id: string;
          project_id: string;
          rule_id: string;
          kind: string;
          value: string;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          rule_id: string;
          kind: string;
          value: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          rule_id?: string;
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
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
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
        };
        Relationships: [
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
          project_id: string;
          predecessor_id: string;
          successor_id: string;
          kind: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          predecessor_id: string;
          successor_id: string;
          kind?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          predecessor_id?: string;
          successor_id?: string;
          kind?: string;
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
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          source: string;
          name: string;
          url?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          source?: string;
          name?: string;
          url?: string | null;
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
          home_project_id: string;
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
          home_project_id: string;
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
          home_project_id?: string;
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
        };
        Insert: {
          id?: string;
          project_id: string;
          status: string;
          note?: string | null;
          author_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          status?: string;
          note?: string | null;
          author_id?: string | null;
          created_at?: string;
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
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      add_portfolio_member: {
        Args: { target_portfolio: string; member_email: string; member_role?: string };
        Returns: string;
      };
      add_portfolio_project: {
        Args: { target_portfolio: string; target_project: string };
        Returns: string;
      };
      add_project_member: {
        Args: { target_project: string; member_email: string; member_role?: string };
        Returns: string;
      };
      add_workspace_admin: {
        Args: { target_workspace: string | null; member_email: string };
        Returns: string;
      };
      add_task_dependency: {
        Args: { predecessor: string; successor: string };
        Returns: string;
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
        Returns: string;
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
          home_project_id: string;
          home_project_name: string;
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
