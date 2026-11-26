/**
 * Where the editor's AI goes (wave 9, Q102–Q105), as pure decisions; the
 * browser side is `resolveEditorAiTarget` (`lib/client/api/backend-resolver.ts`).
 *
 * * agent-py serves it on `python` (signed in) and `python-runs` (signed
 *   in or out), as it serves chat — `resolveModelBackend`'s rules; agent-ts
 *   is frozen, so `ts-service` keeps the Next route (Q105).
 * * A browser with its own AI Gateway key stays on the Next route, which
 *   bills that key; agent-py never takes one (Q103).
 * * On agent-py the editor takes the agent-service models (Q102): a model
 *   it doesn't run is switched to the backend's default, with a note; no
 *   model means agent-py's own default (`AGENT_DEFAULT_MODEL`).
 */

import {
  backendAcceptsModel,
  defaultModelForBackend,
  modelsForBackend,
} from '@/shared/backend-models';
import type { ChatModel } from '@/shared/models';

export type EditorAiBackend = 'agent-py' | 'next';

export function editorAiBackend({
  agentPyConfigured,
  chatBackend,
  ownKey,
  signedIn,
}: {
  agentPyConfigured: boolean;
  chatBackend: 'python' | 'python-runs' | 'ts' | 'ts-service';
  ownKey: boolean;
  signedIn: boolean;
}): EditorAiBackend {
  if (ownKey || !agentPyConfigured) return 'next';
  if (chatBackend === 'python-runs') return 'agent-py';
  if (chatBackend === 'python' && signedIn) return 'agent-py';
  return 'next';
}

/** The model to send agent-py for `requested` (the editor settings' pick). */
export function editorAiModelFor(requested: string | null | undefined): {
  model: string | null;
  switchedFrom: string | null;
} {
  if (!requested) return { model: null, switchedFrom: null };
  if (backendAcceptsModel('agent-service', requested)) {
    return { model: requested, switchedFrom: null };
  }
  return { model: defaultModelForBackend('agent-service'), switchedFrom: requested };
}

/** The editor settings' model list while agent-py serves the editor. */
export function editorAiAgentModels(): ChatModel[] {
  return modelsForBackend('agent-service');
}
