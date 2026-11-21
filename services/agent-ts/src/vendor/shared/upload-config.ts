// VENDORED from `lib/shared/upload-config.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

export const FILE_SIZE_LIMIT = 5 * 1024 * 1024 // 5MB

/**
 * Tighter cap for images. They're base64-encoded into localStorage today
 * (~+33% size overhead vs. the binary), so a 2MB JPEG becomes ~2.7MB in
 * the persist payload. Anything larger threatens the quota when combined
 * with chat history + extracted text.
 */
export const IMAGE_SIZE_LIMIT = 2 * 1024 * 1024 // 2MB

export const ALLOWED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.txt',
  '.csv',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
] as const
