/**
 * Editor media uploader.
 *
 * Routes through Supabase Storage when the user is signed in. Otherwise
 * falls back to a session-only object URL — the media works for the
 * current session but is lost on reload, with a toast informing the
 * user. UploadThing has been removed; signed-out users who want
 * persistence should sign in (or accept the local-only behavior).
 */

import * as React from 'react';

import { toast } from 'sonner';
import { z } from 'zod';

import { getSupabaseBrowserClient } from '@/client/supabase/client';
import { useAuth } from '@/client/hooks/use-auth';
import { uuid } from '@/shared/uuid';

export interface UploadedFile<T = unknown> {
  key: string;
  appUrl: string;
  name: string;
  size: number;
  type: string;
  url: string;
  /** Marker for callers that need to know whether the URL survives a reload. */
  ephemeral?: boolean;
  /** Metadata blob carried for parity with the previous UploadThing return shape. */
  serverData?: T;
}

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
}

export function useUploadFile({
  onUploadComplete,
  onUploadError,
}: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  const { status: authStatus, user } = useAuth();

  async function uploadToSupabaseStorage(file: File): Promise<UploadedFile | null> {
    const client = getSupabaseBrowserClient();
    if (!client || !user) return null;
    const fileId = uuid();
    const ext = file.name.includes('.') ? file.name.split('.').pop()! : 'bin';
    const path = `${user.id}/${fileId}.${ext}`;
    const upload = await client.storage
      .from('user-files')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upload.error) {
      throw new Error(upload.error.message);
    }
    const signed = await client.storage
      .from('user-files')
      .createSignedUrl(path, 60 * 60 * 24 * 365);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error(signed.error?.message ?? 'Failed to sign URL');
    }
    setProgress(100);
    return {
      key: path,
      appUrl: signed.data.signedUrl,
      name: file.name,
      size: file.size,
      type: file.type,
      url: signed.data.signedUrl,
    };
  }

  function buildLocalFile(file: File): UploadedFile {
    return {
      key: `local:${uuid()}`,
      appUrl: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      type: file.type,
      url: URL.createObjectURL(file),
      ephemeral: true,
    };
  }

  async function uploadFile(file: File): Promise<UploadedFile> {
    setIsUploading(true);
    setUploadingFile(file);

    try {
      if (authStatus === 'signed-in' && user) {
        try {
          const result = await uploadToSupabaseStorage(file);
          if (result) {
            setUploadedFile(result);
            onUploadComplete?.(result);
            return result;
          }
        } catch (err) {
          // Surface as a real error rather than silently falling through.
          // The previous behavior masked storage misconfigurations behind
          // an UploadThing fallback that didn't actually fix anything.
          const message = err instanceof Error ? err.message : 'Cloud upload failed';
          toast.error(`Upload failed: ${message}`);
          onUploadError?.(err);
          throw err;
        }
      }

      // Signed-out (or Supabase not configured): keep the file usable for
      // the current session via a blob URL. Flag it as ephemeral so the
      // editor (and any future "this won't persist" UX) can react.
      const local = buildLocalFile(file);
      toast.info(
        `"${file.name}" is only stored in this session. Sign in to save it across reloads.`
      );
      setProgress(100);
      setUploadedFile(local);
      onUploadComplete?.(local);
      return local;
    } finally {
      setProgress(0);
      setIsUploading(false);
      setUploadingFile(undefined);
    }
  }

  return {
    isUploading,
    progress,
    uploadedFile,
    uploadFile,
    uploadingFile,
  };
}

export function getErrorMessage(err: unknown) {
  const unknownError = 'Something went wrong, please try again later.';
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => issue.message).join('\n');
  }
  if (err instanceof Error) return err.message;
  return unknownError;
}

export function showErrorToast(err: unknown) {
  return toast.error(getErrorMessage(err));
}
