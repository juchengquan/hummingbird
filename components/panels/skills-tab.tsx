"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown, Info, Minus, Pin, Plus, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/shared/utils"
import {
  useActiveConversation,
  useActiveWorkspace,
  useStore,
} from "@/client/hooks/use-store"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill, type SkillDescriptor } from "@/shared/skills/types"
import {
  BRAVE_FRESHNESSES,
  BRAVE_FRESHNESS_LABELS,
  DEFAULT_MAX_WEB_SEARCHES,
  EXA_SEARCH_TYPES,
  EXA_SEARCH_TYPE_LABELS,
  MAX_MAX_WEB_SEARCHES,
  MIN_MAX_WEB_SEARCHES,
  TAVILY_SEARCH_DEPTHS,
  clampMaxWebSearches,
  resolveWebSearchConfig,
  type BraveFreshness,
  type ExaSearchType,
  type TavilySearchDepth,
  type WebSearchConfig,
} from "@/shared/skills/web-search-config"
import {
  DEFAULT_MAX_WEB_FETCHES,
  MAX_MAX_WEB_FETCHES,
  MIN_MAX_WEB_FETCHES,
  clampMaxWebFetches,
  resolveWebFetchConfig,
  type WebFetchConfig,
} from "@/shared/skills/web-fetch-config"

/**
 * "Skills" tab in the right activity bar.
 *
 * Each row exposes a three-state segmented control:
 *   - Off                              → conversation override = false
 *   - On for this chat                 → conversation override = true
 *   - On by default in this workspace  → conversation override cleared,
 *                                        workspace default set to true
 *
 * The fourth implicit state ("inherit, workspace default off") shows
 * with no segment active and an explanatory line.
 */
export function SkillsTab() {
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const setWorkspaceSkillPref = useStore((s) => s.setWorkspaceSkillPref)
  const setConversationSkillPref = useStore((s) => s.setConversationSkillPref)
  const patchWorkspaceWebSearchConfig = useStore(
    (s) => s.patchWorkspaceWebSearchConfig
  )
  const patchConversationWebSearchConfig = useStore(
    (s) => s.patchConversationWebSearchConfig
  )
  const patchWorkspaceWebFetchConfig = useStore(
    (s) => s.patchWorkspaceWebFetchConfig
  )
  const patchConversationWebFetchConfig = useStore(
    (s) => s.patchConversationWebFetchConfig
  )

  // Without a workspace there's nothing to edit. With workspace but no
  // conversation, we drop into "workspace defaults" mode: 2-segment
  // Off/On per skill, editing workspace-level prefs directly.
  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-sm text-[var(--muted-foreground)]">
        No active workspace.
      </div>
    )
  }

  const activeSkillsCount = SKILLS.filter((skill) =>
    resolveSkill(skill, workspace.skillPrefs, conversation?.skillPrefs)
  ).length

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center">
        <p className="text-[11px] text-[var(--muted-foreground)]">
          {activeSkillsCount === 0
            ? `No skills active · ${SKILLS.length} available`
            : `${activeSkillsCount} active · ${SKILLS.length} available`}
          {!conversation && (
            <span className="ml-1.5 text-[var(--muted-foreground)]/80">
              · editing workspace defaults
            </span>
          )}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {SKILLS.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            workspacePref={workspace.skillPrefs?.[skill.id]}
            conversationPref={conversation?.skillPrefs?.[skill.id]}
            hasConversation={!!conversation}
            effective={resolveSkill(skill, workspace.skillPrefs, conversation?.skillPrefs)}
            workspaceWebSearchConfig={workspace.webSearchConfig}
            conversationWebSearchConfig={conversation?.webSearchConfig}
            workspaceWebFetchConfig={workspace.webFetchConfig}
            conversationWebFetchConfig={conversation?.webFetchConfig}
            onPatchWorkspace={(patch) =>
              patchWorkspaceWebSearchConfig(workspace.id, patch)
            }
            onPatchConversation={(patch) => {
              if (conversation) {
                patchConversationWebSearchConfig(conversation.id, patch)
              }
            }}
            onPatchWorkspaceWebFetch={(patch) =>
              patchWorkspaceWebFetchConfig(workspace.id, patch)
            }
            onPatchConversationWebFetch={(patch) => {
              if (conversation) {
                patchConversationWebFetchConfig(conversation.id, patch)
              }
            }}
            onSetEffective={(value) => {
              if (conversation) {
                // Per-chat override.
                setConversationSkillPref(conversation.id, skill.id, value)
              } else {
                // No chat in scope: edit workspace default directly.
                setWorkspaceSkillPref(workspace.id, skill.id, value)
              }
            }}
            onPinToWorkspace={(value) => {
              // Promote the current per-chat value to be the workspace
              // default, and drop the per-chat override so this and
              // future chats inherit it.
              if (conversation) {
                setConversationSkillPref(conversation.id, skill.id, null)
              }
              setWorkspaceSkillPref(workspace.id, skill.id, value)
            }}
          />
        ))}
      </div>
    </div>
  )
}

interface SkillRowProps {
  skill: SkillDescriptor
  workspacePref: boolean | undefined
  conversationPref: boolean | undefined
  /** When false, the row drops the pin affordance (no conversation to
   *  override against) and the Off/On toggle edits workspace defaults
   *  directly. */
  hasConversation: boolean
  effective: boolean
  /** Workspace-level webSearch config (cap + per-provider settings).
   *  Undefined = no workspace override. */
  workspaceWebSearchConfig: WebSearchConfig | undefined
  /** Conversation-level webSearch config override. Undefined = inherit. */
  conversationWebSearchConfig: WebSearchConfig | undefined
  /** Workspace-level webFetch config (cap). */
  workspaceWebFetchConfig: WebFetchConfig | undefined
  /** Conversation-level webFetch config override. */
  conversationWebFetchConfig: WebFetchConfig | undefined
  onPatchWorkspace: (
    patch: Partial<WebSearchConfig> | null
  ) => void
  onPatchConversation: (
    patch: Partial<WebSearchConfig> | null
  ) => void
  onPatchWorkspaceWebFetch: (
    patch: Partial<WebFetchConfig> | null
  ) => void
  onPatchConversationWebFetch: (
    patch: Partial<WebFetchConfig> | null
  ) => void
  /** Set the *effective* state for this row. With a conversation in
   *  scope this writes the per-chat override; without one it writes the
   *  workspace default. */
  onSetEffective: (value: boolean) => void
  /** Promote a value to the workspace default *and* clear any
   *  per-conversation override so this and future chats inherit it.
   *  Only called when a conversation is in scope (the pin only shows
   *  in that mode). */
  onPinToWorkspace: (value: boolean) => void
}

function SkillRow({
  skill,
  workspacePref,
  conversationPref,
  hasConversation,
  effective,
  workspaceWebSearchConfig,
  conversationWebSearchConfig,
  workspaceWebFetchConfig,
  conversationWebFetchConfig,
  onPatchWorkspace,
  onPatchConversation,
  onPatchWorkspaceWebFetch,
  onPatchConversationWebFetch,
  onSetEffective,
  onPinToWorkspace,
}: SkillRowProps) {
  const Icon = skill.icon
  // Whether this chat is currently using the workspace default (no
  // per-chat override). Drives the pin's visual state and disables the
  // pin button when there's nothing to promote (already matching the
  // workspace default).
  const isInheriting =
    hasConversation && conversationPref === undefined
  const matchesWorkspace =
    isInheriting && workspacePref === effective

  // Per-row expansion for skills with a settings panel (webSearch +
  // webFetch). Defaults to collapsed; the user clicks the chevron to
  // reveal the panel. Local state — ephemeral, resets on remount,
  // intentionally not persisted.
  const hasSettingsPanel = skill.id === "webSearch" || skill.id === "webFetch"
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-md border border-[var(--border)] p-3 space-y-2">
      {/* Single header row: icon → title → switch → pin → chevron.
          Everything lives in one `items-center` flex line so the controls
          sit right of the title rather than wrapping onto a second row.
          The row's fixed `h-6` height keeps the title's vertical
          position stable when the chevron appears/disappears as the
          skill is toggled. */}
      <div className="flex items-center gap-2 h-6">
        <Icon size={16} className="shrink-0 text-[var(--muted-foreground)]" />
        <TruncatedTitle name={skill.name} />
        <Switch
          checked={effective}
          onCheckedChange={onSetEffective}
          aria-label={`${effective ? "Disable" : "Enable"} ${skill.name}`}
        />
        {hasConversation && (
          <PinDefaultButton
            pinned={matchesWorkspace}
            onClick={() => onPinToWorkspace(effective)}
          />
        )}
        {hasSettingsPanel && (
          // Chevron is always rendered (not gated on `effective`) so
          // toggling the skill on/off doesn't shift the surrounding
          // layout. Users can also pre-configure providers and settings
          // before flipping the switch on.
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={expanded ? "Collapse settings" : "Expand settings"}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="h-6 w-6 -mr-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <ChevronDown
              size={14}
              className={cn(
                "transition-transform duration-150",
                expanded ? "rotate-180" : "rotate-0"
              )}
            />
          </Button>
        )}
      </div>
      {/* Description only when expanded. `pl-6` (= icon width 16 + gap 8)
          hangs the text under the title rather than under the icon. */}
      {(!hasSettingsPanel || expanded) && (
        <p className="text-[11px] text-[var(--muted-foreground)] leading-snug pl-6">
          {skill.description}
        </p>
      )}

      {skill.id === "webFetch" && expanded && (
        <WebFetchSettingsPanel
          hasConversation={hasConversation}
          workspaceConfig={workspaceWebFetchConfig}
          conversationConfig={conversationWebFetchConfig}
          onPatchWorkspace={onPatchWorkspaceWebFetch}
          onPatchConversation={onPatchConversationWebFetch}
        />
      )}

      {skill.id === "webSearch" && expanded && (
        <WebSearchSettingsPanel
          hasConversation={hasConversation}
          workspaceConfig={workspaceWebSearchConfig}
          conversationConfig={conversationWebSearchConfig}
          onPatchWorkspace={onPatchWorkspace}
          onPatchConversation={onPatchConversation}
        />
      )}

      {skill.requiresEnv && effective && skill.id !== "webSearch" && (
        <p className="text-[10px] text-amber-600 dark:text-amber-500 inline-flex items-center gap-1">
          <Info size={10} />
          Requires server configuration. The model is told if the API key
          isn&apos;t set; the toggle still records your intent.
        </p>
      )}
    </div>
  )
}

interface WebSearchSettingsPanelProps {
  hasConversation: boolean
  workspaceConfig: WebSearchConfig | undefined
  conversationConfig: WebSearchConfig | undefined
  onPatchWorkspace: (patch: Partial<WebSearchConfig> | null) => void
  onPatchConversation: (patch: Partial<WebSearchConfig> | null) => void
}

/**
 * Expanded settings shown under the Web search row when the skill is on.
 * Contains: (1) the per-turn max-calls stepper (tool-level), (2) a Tavily
 * provider section with its own toggle + search-depth select, (3) a
 * Brave provider section with toggle + freshness select.
 *
 * When a conversation is active the panel edits the per-conversation
 * override; without one, it edits the workspace default. Field-level
 * inheritance ("Inherits N from workspace") is shown next to each
 * effective value so the user knows where it's coming from.
 */
function WebSearchSettingsPanel({
  hasConversation,
  workspaceConfig,
  conversationConfig,
  onPatchWorkspace,
  onPatchConversation,
}: WebSearchSettingsPanelProps) {
  const resolved = resolveWebSearchConfig(workspaceConfig, conversationConfig)
  const editingConversation = hasConversation
  // Convenience patcher: writes either to conversation or workspace
  // depending on scope.
  const patch = (p: Partial<WebSearchConfig>) => {
    if (editingConversation) onPatchConversation(p)
    else onPatchWorkspace(p)
  }
  const ownConfig = editingConversation ? conversationConfig : workspaceConfig

  return (
    <div className="space-y-2.5 pt-1">
      <MaxCallsStepper
        label="Max searches"
        effective={resolved.maxCalls}
        ownValue={ownConfig?.maxCalls}
        workspaceValue={workspaceConfig?.maxCalls}
        editingConversation={editingConversation}
        min={MIN_MAX_WEB_SEARCHES}
        max={MAX_MAX_WEB_SEARCHES}
        defaultValue={DEFAULT_MAX_WEB_SEARCHES}
        clamp={clampMaxWebSearches}
        onCommit={(value) => patch({ maxCalls: value })}
        onReset={() => patch({ maxCalls: undefined })}
      />

      <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-2.5 space-y-2">
        <ProviderHeader
          name="Tavily"
          enabled={resolved.tavily.enabled}
          ownEnabled={ownConfig?.tavily?.enabled}
          workspaceEnabled={workspaceConfig?.tavily?.enabled}
          editingConversation={editingConversation}
          onToggle={(value) =>
            patch({
              tavily: { ...(ownConfig?.tavily ?? {}), enabled: value },
            })
          }
        />
        {resolved.tavily.enabled && (
          <InlineSelectRow
            label="Search depth"
            value={resolved.tavily.searchDepth}
            options={TAVILY_SEARCH_DEPTHS.map((d) => ({
              value: d,
              label: d === "basic" ? "Basic (fast)" : "Advanced (thorough)",
            }))}
            onChange={(value) =>
              patch({
                tavily: {
                  ...(ownConfig?.tavily ?? {}),
                  searchDepth: value as TavilySearchDepth,
                },
              })
            }
          />
        )}
      </div>

      <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-2.5 space-y-2">
        <ProviderHeader
          name="Brave"
          enabled={resolved.brave.enabled}
          ownEnabled={ownConfig?.brave?.enabled}
          workspaceEnabled={workspaceConfig?.brave?.enabled}
          editingConversation={editingConversation}
          onToggle={(value) =>
            patch({
              brave: { ...(ownConfig?.brave ?? {}), enabled: value },
            })
          }
        />
        {resolved.brave.enabled && (
          <InlineSelectRow
            label="Freshness"
            value={resolved.brave.freshness}
            options={BRAVE_FRESHNESSES.map((f) => ({
              value: f,
              label: BRAVE_FRESHNESS_LABELS[f],
            }))}
            onChange={(value) =>
              patch({
                brave: {
                  ...(ownConfig?.brave ?? {}),
                  freshness: value as BraveFreshness,
                },
              })
            }
          />
        )}
      </div>

      <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-2.5 space-y-2">
        <ProviderHeader
          name="Exa"
          enabled={resolved.exa.enabled}
          ownEnabled={ownConfig?.exa?.enabled}
          workspaceEnabled={workspaceConfig?.exa?.enabled}
          editingConversation={editingConversation}
          onToggle={(value) =>
            patch({
              exa: { ...(ownConfig?.exa ?? {}), enabled: value },
            })
          }
        />
        {resolved.exa.enabled && (
          <InlineSelectRow
            label="Search type"
            value={resolved.exa.type}
            options={EXA_SEARCH_TYPES.map((t) => ({
              value: t,
              label: EXA_SEARCH_TYPE_LABELS[t],
            }))}
            onChange={(value) =>
              patch({
                exa: {
                  ...(ownConfig?.exa ?? {}),
                  type: value as ExaSearchType,
                },
              })
            }
          />
        )}
      </div>

      {!resolved.tavily.enabled &&
        !resolved.brave.enabled &&
        !resolved.exa.enabled && (
          <p className="text-[10px] text-amber-600 dark:text-amber-500 inline-flex items-center gap-1">
            <Info size={10} />
            All providers disabled — Web search is effectively off.
          </p>
        )}
    </div>
  )
}

interface WebFetchSettingsPanelProps {
  hasConversation: boolean
  workspaceConfig: WebFetchConfig | undefined
  conversationConfig: WebFetchConfig | undefined
  onPatchWorkspace: (patch: Partial<WebFetchConfig> | null) => void
  onPatchConversation: (patch: Partial<WebFetchConfig> | null) => void
}

/**
 * Expanded settings shown under the Web fetch row. Just the per-turn
 * max-calls stepper today; same cascade semantics as the webSearch
 * panel (workspace default vs conversation override). Kept as its own
 * component so future webFetch knobs (allowlists, content limits) slot
 * in without further work in the row itself.
 */
function WebFetchSettingsPanel({
  hasConversation,
  workspaceConfig,
  conversationConfig,
  onPatchWorkspace,
  onPatchConversation,
}: WebFetchSettingsPanelProps) {
  const resolved = resolveWebFetchConfig(workspaceConfig, conversationConfig)
  const editingConversation = hasConversation
  const patch = (p: Partial<WebFetchConfig>) => {
    if (editingConversation) onPatchConversation(p)
    else onPatchWorkspace(p)
  }
  const ownConfig = editingConversation ? conversationConfig : workspaceConfig

  return (
    <div className="space-y-2.5 pt-1">
      <MaxCallsStepper
        label="Max fetches"
        effective={resolved.maxCalls}
        ownValue={ownConfig?.maxCalls}
        workspaceValue={workspaceConfig?.maxCalls}
        editingConversation={editingConversation}
        min={MIN_MAX_WEB_FETCHES}
        max={MAX_MAX_WEB_FETCHES}
        defaultValue={DEFAULT_MAX_WEB_FETCHES}
        clamp={clampMaxWebFetches}
        onCommit={(value) => patch({ maxCalls: value })}
        onReset={() => patch({ maxCalls: undefined })}
      />
    </div>
  )
}

/** Max-calls stepper extracted so the panel stays readable. Generic
 *  over the label + clamp/bounds so webSearch and webFetch can both
 *  use it. */
function MaxCallsStepper({
  label,
  effective,
  ownValue,
  workspaceValue,
  editingConversation,
  min,
  max,
  defaultValue,
  clamp,
  onCommit,
  onReset,
}: {
  label: string
  effective: number
  ownValue: number | undefined
  workspaceValue: number | undefined
  editingConversation: boolean
  min: number
  max: number
  defaultValue: number
  clamp: (n: number) => number
  onCommit: (value: number) => void
  onReset: () => void
}) {
  const isOverride = editingConversation && ownValue !== undefined
  const commit = (raw: number) => {
    const next = clamp(raw)
    if (next === effective) return
    onCommit(next)
  }
  const applyDelta = (delta: number) => commit(effective + delta)
  // Locally-controlled draft so the user can clear/type freely.
  const [draft, setDraft] = useState<string>(String(effective))
  useEffect(() => {
    setDraft(String(effective))
  }, [effective])
  const commitDraft = () => {
    const parsed = parseInt(draft, 10)
    if (Number.isNaN(parsed)) {
      setDraft(String(effective))
      return
    }
    commit(parsed)
  }
  const atMin = effective <= min
  const atMax = effective >= max
  const showReset = ownValue !== undefined && ownValue !== defaultValue

  const sublabel = editingConversation
    ? isOverride
      ? "Chat override"
      : workspaceValue !== undefined
        ? `Inherits ${workspaceValue} from workspace`
        : `Default ${defaultValue}`
    : workspaceValue !== undefined
      ? "Workspace default"
      : `Default ${defaultValue}`

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--foreground)] leading-tight">
          {label}
        </p>
        <p className="text-[10px] text-[var(--muted-foreground)] leading-tight">
          {sublabel}
        </p>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {showReset && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Reset to default"
            title="Reset to default"
            onClick={onReset}
            className="h-6 w-6 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <RotateCcw size={11} />
          </Button>
        )}
        <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Decrease ${label.toLowerCase()}`}
            onClick={() => applyDelta(-1)}
            disabled={atMin}
            className="h-6 w-6 rounded-none border-r border-[var(--border)]"
          >
            <Minus size={11} />
          </Button>
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
              else if (e.key === "Escape") {
                setDraft(String(effective))
                e.currentTarget.blur()
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={label}
            className={cn(
              "text-[11px] font-mono px-2 w-9 text-center tabular-nums bg-transparent",
              "border-0 outline-none focus:bg-[var(--muted)]/40",
              "[appearance:textfield]",
              "[&::-webkit-outer-spin-button]:appearance-none",
              "[&::-webkit-inner-spin-button]:appearance-none"
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Increase ${label.toLowerCase()}`}
            onClick={() => applyDelta(1)}
            disabled={atMax}
            className="h-6 w-6 rounded-none border-l border-[var(--border)]"
          >
            <Plus size={11} />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Provider header row: name + on/off toggle. */
function ProviderHeader({
  name,
  enabled,
  ownEnabled,
  workspaceEnabled,
  editingConversation,
  onToggle,
}: {
  name: string
  enabled: boolean
  ownEnabled: boolean | undefined
  workspaceEnabled: boolean | undefined
  editingConversation: boolean
  onToggle: (value: boolean) => void
}) {
  // Show a small inheritance hint next to the provider name so the user
  // knows the value is cascading rather than set explicitly here.
  const inheritsLabel = editingConversation && ownEnabled === undefined
    ? workspaceEnabled === false
      ? " · inherited off"
      : workspaceEnabled === true
        ? " · inherited on"
        : ""
    : ""
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-[var(--foreground)] leading-tight">
          {name}
          <span className="text-[10px] text-[var(--muted-foreground)] font-normal">
            {inheritsLabel}
          </span>
        </p>
      </div>
      <PillToggle
        active={enabled}
        onClick={() => onToggle(!enabled)}
        ariaLabel={`Toggle ${name}`}
      />
    </div>
  )
}

/** Small label + select row. Generic so provider sections share it. */
function InlineSelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-[11px] text-[var(--muted-foreground)] leading-tight">
        {label}
      </p>
      <div className="shrink-0">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          aria-label={label}
          className={cn(
            "text-[11px] rounded-md border border-[var(--border)] bg-[var(--background)]",
            "px-2 py-0.5 h-6 outline-none focus:ring-1 focus:ring-[var(--primary)]/40"
          )}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/**
 * Pill-style single-click toggle. Used for provider on/off inside the
 * webSearch settings panel, where a binary tap-to-toggle reads cleaner
 * than a two-segment "Off / On" control. Filled in primary tint when
 * active; outlined and muted when not.
 */
function PillToggle({
  active,
  onClick,
  ariaLabel,
}: {
  active: boolean
  onClick: () => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "h-6 px-2.5 rounded-full text-[10px] font-medium leading-none",
        "inline-flex items-center gap-1 select-none transition-colors",
        "border focus-visible:outline-none focus-visible:ring-2",
        "focus-visible:ring-[var(--primary)]/40",
        active
          ? "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/40 hover:bg-[var(--primary)]/20"
          : "bg-transparent text-[var(--muted-foreground)] border-[var(--border)] hover:text-[var(--foreground)] hover:border-[var(--muted-foreground)]/40"
      )}
    >
      <span
        className={cn(
          "inline-block w-1.5 h-1.5 rounded-full",
          active ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/50"
        )}
      />
      {active ? "On" : "Off"}
    </button>
  )
}

/**
 * Skill row title. Truncates with ellipsis when too long for the
 * available width (we live in a narrow ~272px rail), and pops the full
 * name in a tooltip on hover/focus — but only when it actually overflows.
 * No tooltip noise on short names like "Web search".
 *
 * Overflow detection: compare `scrollWidth` vs `clientWidth` whenever the
 * title resizes or the name changes. ResizeObserver covers panel-width
 * changes (collapsed vs expanded sidebar, browser resize, mobile
 * landscape→portrait, etc.) without polling.
 */
function TruncatedTitle({ name }: { name: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [name])
  const titleEl = (
    <p
      ref={ref}
      className="text-sm font-medium flex-1 min-w-0 truncate cursor-default"
    >
      {name}
    </p>
  )
  if (!overflowing) return titleEl
  return (
    <Tooltip>
      <TooltipTrigger asChild>{titleEl}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-[260px]">
        {name}
      </TooltipContent>
    </Tooltip>
  )
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 rounded-none text-[10px] px-1 border-r border-[var(--border)] last:border-r-0",
        active
          ? "bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/15"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      )}
    >
      {children}
    </Button>
  )
}

/**
 * "Save this on/off as the workspace default" affordance shown next to
 * the per-chat toggle. Renders a small pin icon with a Radix tooltip on
 * hover/focus explaining what clicking will do (vs the title attribute,
 * which is OS-style and easy to miss).
 *
 * Two visual states:
 *   - `pinned` = the current chat is already inheriting from a matching
 *     workspace default. The icon fills with the primary tint; click is
 *     a no-op (button is disabled). Communicates "this is the default."
 *   - not pinned = the chat has its own override OR the workspace
 *     default differs. Icon is outlined/muted; click promotes the
 *     current chat value to the workspace default and clears the
 *     override so this and future chats inherit it.
 */
function PinDefaultButton({
  pinned,
  onClick,
}: {
  pinned: boolean
  onClick: () => void
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={pinned}
      aria-label={
        pinned
          ? "Already the workspace default"
          : "Set as workspace default for new chats"
      }
      className={cn(
        "h-6 w-6 rounded-md transition-colors shrink-0",
        pinned
          ? "text-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-100"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      )}
    >
      <Pin
        size={12}
        className={cn(pinned && "fill-current")}
      />
    </Button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Wrap disabled button in a span so the tooltip still triggers
            (Radix can't attach listeners to a disabled button directly). */}
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-[220px]">
        {pinned ? (
          <p className="leading-snug">
            <span className="font-medium">Workspace default.</span>{" "}
            <span className="opacity-80">
              New chats in this workspace will start with this setting.
            </span>
          </p>
        ) : (
          <p className="leading-snug">
            <span className="font-medium">Pin as workspace default.</span>{" "}
            <span className="opacity-80">
              Save this on/off as the starting value for new chats in this
              workspace.
            </span>
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
