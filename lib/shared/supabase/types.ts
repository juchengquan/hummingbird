/**
 * Hand-rolled Database type mirroring `supabase/migrations/0001_schema.sql`.
 *
 * The Row / Insert / Update shape on each table must match the
 * column set in the schema file — when you change one, change the
 * other. Generated equivalent (more thorough nullability annotations):
 *
 *   bunx supabase gen types typescript --project-id <ref> > lib/supabase/types.ts
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
      documents: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          title: string
          content: string
          position: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          title: string
          content?: string
          position?: number | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          title?: string
          content?: string
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
          selected_mcp_resource_ids: string[]
          selected_url_bookmark_ids: string[]
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
          selected_mcp_resource_ids?: string[]
          selected_url_bookmark_ids?: string[]
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
          selected_mcp_resource_ids?: string[]
          selected_url_bookmark_ids?: string[]
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
          compressed: boolean
          kind: string | null
          recap_message_ids: string[]
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
          compressed?: boolean
          kind?: string | null
          recap_message_ids?: string[]
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
          compressed?: boolean
          kind?: string | null
          recap_message_ids?: string[]
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
          deleted_at: string | null
          full_text: string | null
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
          deleted_at?: string | null
          full_text?: string | null
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
          deleted_at?: string | null
          full_text?: string | null
        }
        Relationships: []
      }
      conversation_files: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          file_id: string
          added_at: string
        }
        Insert: {
          id: string
          user_id: string
          conversation_id: string
          file_id: string
          added_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          file_id?: string
          added_at?: string
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
          // Conversation shares (kind='conversation') set conversation_id;
          // document shares (kind='document') set document_id. The DB
          // check constraint enforces exactly one is non-null.
          conversation_id: string | null
          document_id: string | null
          created_at: string
          revoked_at: string | null
        }
        Insert: {
          token: string
          user_id: string
          kind: 'conversation' | 'document'
          conversation_id?: string | null
          document_id?: string | null
          created_at?: string
          revoked_at?: string | null
        }
        Update: {
          token?: string
          user_id?: string
          kind?: 'conversation' | 'document'
          conversation_id?: string | null
          document_id?: string | null
          created_at?: string
          revoked_at?: string | null
        }
        Relationships: []
      }
      mcp_servers: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          name: string
          url: string
          transport: 'http'
          credential_mode: 'cloud' | 'local'
          credentials_encrypted: string | null
          credential_fingerprint: string | null
          capabilities: Json | null
          capabilities_fetched_at: string | null
          enabled: boolean
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          name: string
          url: string
          transport?: 'http'
          credential_mode: 'cloud' | 'local'
          credentials_encrypted?: string | null
          credential_fingerprint?: string | null
          capabilities?: Json | null
          capabilities_fetched_at?: string | null
          enabled?: boolean
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          name?: string
          url?: string
          transport?: 'http'
          credential_mode?: 'cloud' | 'local'
          credentials_encrypted?: string | null
          credential_fingerprint?: string | null
          capabilities?: Json | null
          capabilities_fetched_at?: string | null
          enabled?: boolean
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Relationships: []
      }
      mcp_resources: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          server_id: string
          uri: string
          name: string
          description: string | null
          mime_type: string | null
          added_at: string
          deleted_at: string | null
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          server_id: string
          uri: string
          name: string
          description?: string | null
          mime_type?: string | null
          added_at?: string
          deleted_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          server_id?: string
          uri?: string
          name?: string
          description?: string | null
          mime_type?: string | null
          added_at?: string
          deleted_at?: string | null
        }
        Relationships: []
      }
      mcp_resource_bindings: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          resource_id: string
          added_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          resource_id: string
          added_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          resource_id?: string
          added_at?: string
        }
        Relationships: []
      }
      conversation_mcp_resources: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          resource_id: string
          added_at: string
        }
        Insert: {
          id: string
          user_id: string
          conversation_id: string
          resource_id: string
          added_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          resource_id?: string
          added_at?: string
        }
        Relationships: []
      }
      url_bookmarks: {
        Row: {
          id: string
          user_id: string
          workspace_id: string
          url: string
          title: string
          content: string
          content_truncated: boolean
          content_hash: string
          description: string | null
          favicon_url: string | null
          fetched_at: string
          deleted_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          user_id: string
          workspace_id: string
          url: string
          title: string
          content?: string
          content_truncated?: boolean
          content_hash: string
          description?: string | null
          favicon_url?: string | null
          fetched_at?: string
          deleted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          workspace_id?: string
          url?: string
          title?: string
          content?: string
          content_truncated?: boolean
          content_hash?: string
          description?: string | null
          favicon_url?: string | null
          fetched_at?: string
          deleted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      conversation_url_bookmarks: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          bookmark_id: string
          added_at: string
        }
        Insert: {
          id: string
          user_id: string
          conversation_id: string
          bookmark_id: string
          added_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          bookmark_id?: string
          added_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      mcp_get_decrypted_credentials: {
        Args: { p_server_id: string; p_key: string }
        Returns: Json | null
      }
      mcp_upsert_server_with_credentials: {
        Args: {
          p_id: string
          p_workspace_id: string
          p_name: string
          p_url: string
          p_credentials: Json
          p_key: string
          p_capabilities?: Json | null
          p_enabled?: boolean
        }
        Returns: void
      }
      search_file_sections: {
        Args: {
          p_file_id: string
          p_query: string
          p_max_fragments?: number
          p_max_words?: number
          p_min_words?: number
        }
        Returns: {
          excerpt: string
          rank: number
        }[]
      }
    }
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
