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
      comments: {
        Row: {
          id: string;
          task_id: string;
          author_id: string | null;
          body: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
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
      inbox_items: {
        Row: {
          id: string;
          recipient_id: string;
          actor_id: string | null;
          task_id: string;
          comment_id: string | null;
          kind: string;
          read_at: string | null;
          created_at: string;
          data: Json;
        };
        Insert: {
          id?: string;
          recipient_id: string;
          actor_id?: string | null;
          task_id: string;
          comment_id?: string | null;
          kind: string;
          read_at?: string | null;
          created_at?: string;
          data?: Json;
        };
        Update: {
          id?: string;
          recipient_id?: string;
          actor_id?: string | null;
          task_id?: string;
          comment_id?: string | null;
          kind?: string;
          read_at?: string | null;
          created_at?: string;
          data?: Json;
        };
        Relationships: [
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
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          source: string;
          req_project_id: string | null;
          req_number: number | null;
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
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          source?: string;
          req_project_id?: string | null;
          req_number?: number | null;
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
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
          source?: string;
          req_project_id?: string | null;
          req_number?: number | null;
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
            foreignKeyName: "tasks_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
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
      assign_request_number: {
        Args: { target_task: string };
        Returns: string;
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
      get_public_form: {
        Args: { target_form: string };
        Returns: Json;
      };
      install_rule_preset: {
        Args: { target_project: string; preset: string; inputs?: Json; enable?: boolean };
        Returns: string[];
      };
      is_allowlisted: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      project_metrics: {
        Args: { target_project: string; filters?: Json; group_by?: string; tz?: string };
        Returns: { bucket: string | null; task_count: number }[];
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
      submit_form: {
        Args: { target_form: string; submitter_email: string; answers: Json };
        Returns: Json;
      };
      task_request_label: {
        Args: { target_task: string };
        Returns: string | null;
      };
      workflow_tick: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
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
