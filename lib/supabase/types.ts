/**
 * Hand-rolled Database type covering the Phase-1 migrations as applied:
 *   - supabase/migrations/0001_initial_schema.sql
 *   - supabase/migrations/0002_conversation_assets.sql
 *
 * Swap in `bunx supabase gen types typescript --project-id <ref> > lib/supabase/types.ts`
 * once an access token is available. Same surface; more thorough nullability
 * annotations.
 *
 * Includes columns added by 0004 (`reasoning`, error, file extraction
 * fields, system_prompt, etc.) so the sync layer can persist and rehydrate
 * the full runtime state on refresh / cross-device.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string | null
          created_at: string
        }
        Insert: {
          id: string
          email?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          email?: string | null
          created_at?: string
        }
        Relationships: []
      }
      workspaces: {
        Row: {
          id: string
          user_id: string
          name: string
          system_prompt: string | null
          skill_prefs: Json
          default_model: string | null
          position: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          user_id: string
          name: string
          system_prompt?: string | null
          skill_prefs?: Json
          default_model?: string | null
          position?: number | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          system_prompt?: string | null
          skill_prefs?: Json
          default_model?: string | null
          position?: number | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          title: string
          pinned: boolean
          selected_file_ids: string[]
          document_content: string
          document_updated_at: string
          skill_prefs: Json
          parent_id: string | null
          forked_from_message_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          title: string
          pinned?: boolean
          selected_file_ids?: string[]
          document_content?: string
          document_updated_at?: string
          skill_prefs?: Json
          parent_id?: string | null
          forked_from_message_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          title?: string
          pinned?: boolean
          selected_file_ids?: string[]
          document_content?: string
          document_updated_at?: string
          skill_prefs?: Json
          parent_id?: string | null
          forked_from_message_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          role: 'user' | 'assistant'
          content: string
          position: number
          reasoning: string | null
          reasoning_duration_ms: number | null
          error: Json | null
          tool_calls: Json | null
          attached_file_ids: string[]
          suggestions: string[]
          created_at: string
        }
        Insert: {
          id: string
          user_id: string
          conversation_id: string
          role: 'user' | 'assistant'
          content: string
          position: number
          reasoning?: string | null
          reasoning_duration_ms?: number | null
          error?: Json | null
          tool_calls?: Json | null
          attached_file_ids?: string[]
          suggestions?: string[]
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          role?: 'user' | 'assistant'
          content?: string
          position?: number
          reasoning?: string | null
          reasoning_duration_ms?: number | null
          error?: Json | null
          tool_calls?: Json | null
          attached_file_ids?: string[]
          suggestions?: string[]
          created_at?: string
        }
        Relationships: []
      }
      files: {
        Row: {
          id: string
          user_id: string
          name: string
          size: number
          type: string
          storage_path: string | null
          external_url: string | null
          extraction_status: 'pending' | 'done' | 'failed' | 'unsupported' | null
          extracted_text: string | null
          extraction_truncated: boolean
          extracted_kind: string | null
          image_data_url: string | null
          summary: string | null
          key_topics: string[]
          uploaded_at: string
        }
        Insert: {
          id: string
          user_id: string
          name: string
          size: number
          type: string
          storage_path?: string | null
          external_url?: string | null
          extraction_status?: 'pending' | 'done' | 'failed' | 'unsupported' | null
          extracted_text?: string | null
          extraction_truncated?: boolean
          extracted_kind?: string | null
          image_data_url?: string | null
          summary?: string | null
          key_topics?: string[]
          uploaded_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          size?: number
          type?: string
          storage_path?: string | null
          external_url?: string | null
          extraction_status?: 'pending' | 'done' | 'failed' | 'unsupported' | null
          extracted_text?: string | null
          extraction_truncated?: boolean
          extracted_kind?: string | null
          image_data_url?: string | null
          summary?: string | null
          key_topics?: string[]
          uploaded_at?: string
        }
        Relationships: []
      }
      resources: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          file_id: string
          added_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          file_id: string
          added_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          file_id?: string
          added_at?: string
        }
        Relationships: []
      }
      artifacts: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          conversation_id: string | null
          message_id: string | null
          kind: 'code' | 'markdown' | 'image' | 'table' | 'json' | 'other'
          language: string | null
          title: string | null
          content: string | null
          storage_path: string | null
          pinned: boolean
          created_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          conversation_id?: string | null
          message_id?: string | null
          kind: 'code' | 'markdown' | 'image' | 'table' | 'json' | 'other'
          language?: string | null
          title?: string | null
          content?: string | null
          storage_path?: string | null
          pinned?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          conversation_id?: string | null
          message_id?: string | null
          kind?: 'code' | 'markdown' | 'image' | 'table' | 'json' | 'other'
          language?: string | null
          title?: string | null
          content?: string | null
          storage_path?: string | null
          pinned?: boolean
          created_at?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          conversation_id: string | null
          message_id: string | null
          body: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          conversation_id?: string | null
          message_id?: string | null
          body: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          conversation_id?: string | null
          message_id?: string | null
          body?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      shares: {
        Row: {
          token: string
          user_id: string
          kind: 'conversation' | 'document'
          conversation_id: string
          created_at: string
          revoked_at: string | null
        }
        Insert: {
          token: string
          user_id: string
          kind: 'conversation' | 'document'
          conversation_id: string
          created_at?: string
          revoked_at?: string | null
        }
        Update: {
          token?: string
          user_id?: string
          kind?: 'conversation' | 'document'
          conversation_id?: string
          created_at?: string
          revoked_at?: string | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

/** Row type helper. */
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']
/** Insert type helper. */
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']
/** Update type helper. */
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']
