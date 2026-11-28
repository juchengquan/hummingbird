/**
 * The editor's AI models (wave 9, Q102–Q105), as pure decisions. agent-py
 * serves the editor's AI (`/v1/ai/command`, `/v1/ai/complete`) — the only
 * backend since wave 13 — signed in or out, as it serves chat. There is no
 * own-key setting (wave 12, Q124: agent-py never takes a user's key, Q103).
 *
 * The editor takes the models agent-py serves chat on (Q102), except
 * `auto` (the editor routes don't resolve it): a model it doesn't run is
 * switched to agent-py's default, with a note; no model means agent-py's
 * own default (`AGENT_DEFAULT_MODEL`).
 */

import {
  backendAcceptsModel,
  defaultModelForBackend,
  modelsForBackend,
} from '@/shared/backend-models';
import { isAutoModel, type ChatModel } from '@/shared/models';

/** The model to send agent-py for `requested` (the editor settings' pick). */
export function editorAiModelFor(requested: string | null | undefined): {
  model: string | null;
  switchedFrom: string | null;
} {
  if (!requested) return { model: null, switchedFrom: null };
  if (!isAutoModel(requested) && backendAcceptsModel('agent-runs', requested)) {
    return { model: requested, switchedFrom: null };
  }
  return { model: defaultModelForBackend('agent-runs'), switchedFrom: requested };
}

/** The editor settings' model list: what agent-py runs. */
export function editorAiModels(): ChatModel[] {
  return modelsForBackend('agent-runs');
}
