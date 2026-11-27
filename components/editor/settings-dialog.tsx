'use client';

import * as React from 'react';

import { CopilotPlugin } from '@platejs/ai/react';
import { Check, ChevronsUpDown, Settings, Wand2Icon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { isAgentPyConfigured } from '@/client/api-client';
import { noticeEditorKeyRemoved } from '@/client/editor/editor-key-notice';
import { useAuth } from '@/client/hooks/use-auth';
import { useStore } from '@/client/hooks/use-store';
import { useServedModels } from '@/client/hooks/use-served-models';
import { editorAiBackend, editorAiModels } from '@/shared/editor-ai/routing';
import { cn } from '@/shared/utils';

import { aiChatPlugin } from './plugins/ai-kit';

type Model = {
  label: string;
  value: string;
};

/**
 * The editor's AI settings: the model its AI menu and ghost text use.
 *
 * Wave 12 (Q124): there is no AI Gateway key field any more — agent-py
 * never takes a user's key (Q103) — so the editor always uses the deploy's
 * models: what agent-py runs where it serves the editor (Q102), else the
 * catalog on the Next route's own key. The first open after the change
 * says so once (`noticeEditorKeyRemoved`).
 */
export function SettingsDialog() {
  const editor = useEditorRef();

  const [tempModel, setTempModel] = React.useState<Model | null>(null);
  const [open, setOpen] = React.useState(false);
  const [openModel, setOpenModel] = React.useState(false);

  const chatBackend = useStore((s) => s.chatBackend);
  const { status } = useAuth();
  const backend = editorAiBackend({
    agentPyConfigured: isAgentPyConfigured(),
    chatBackend,
    signedIn: status === 'signed-in',
  });
  const onAgentPy = backend === 'agent-py';
  useServedModels(); // agent-py's models, when they arrive (Q119)
  const offered: Model[] = editorAiModels(backend).map((m) => ({ label: m.label, value: m.id }));
  // A pick the backend doesn't run shows as switched to the first it does.
  const shownModel =
    offered.find((m) => m.value === tempModel?.value) ?? offered[0] ?? tempModel;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) noticeEditorKeyRemoved();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setOpen(false);
    if (!shownModel) return;

    // Update AI chat options
    const chatOptions = editor.getOptions(aiChatPlugin).chatOptions ?? {};
    editor.setOption(aiChatPlugin, 'chatOptions', {
      ...chatOptions,
      body: {
        ...chatOptions.body,
        model: shownModel.value,
      },
    });

    // Update AI complete options
    const completeOptions =
      editor.getOptions(CopilotPlugin).completeOptions ?? {};
    editor.setOption(CopilotPlugin, 'completeOptions', {
      ...completeOptions,
      body: {
        ...completeOptions.body,
        model: shownModel.value,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="default"
          className={cn(
            'group fixed right-4 bottom-4 z-50 size-10 overflow-hidden',
            'rounded-full shadow-md hover:shadow-lg'
          )}
          aria-label="Editor AI settings"
        >
          <Settings className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-xl">Settings</DialogTitle>
          <DialogDescription>
            Pick the model the editor&apos;s AI uses. It runs on this
            deploy&apos;s models.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-10" onSubmit={handleSubmit}>
          {/* AI Settings Group */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="size-8 rounded-full bg-purple-100 p-2 dark:bg-purple-900">
                <Wand2Icon className="size-4 text-purple-600 dark:text-purple-400" />
              </div>
              <h4 className="font-semibold">AI</h4>
            </div>

            <div className="space-y-4">
              <div className="group relative">
                <label
                  className="-translate-y-1/2 absolute start-1 top-0 z-10 block bg-background px-2 font-medium text-foreground text-xs group-has-disabled:opacity-50"
                  htmlFor="select-model"
                >
                  Model
                </label>
                <Popover open={openModel} onOpenChange={setOpenModel}>
                  <PopoverTrigger id="select-model" asChild>
                    <Button
                      size="lg"
                      variant="outline"
                      className="w-full justify-between"
                      aria-expanded={openModel}
                      role="combobox"
                    >
                      <code>{shownModel?.label ?? 'No model available'}</code>
                      <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0">
                    <Command>
                      <CommandInput placeholder="Search model..." />
                      <CommandEmpty>No model found.</CommandEmpty>
                      <CommandList>
                        <CommandGroup>
                          {offered.map((m) => (
                            <CommandItem
                              key={m.value}
                              value={m.value}
                              onSelect={() => {
                                setTempModel(m);
                                setOpenModel(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  'mr-2 size-4',
                                  shownModel?.value === m.value
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                              <code>{m.label}</code>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {onAgentPy && (
                  <p className="mt-2 text-muted-foreground text-xs" data-testid="editor-ai-agent-py-note">
                    Editor AI runs on agent-py, which offers these models.
                  </p>
                )}
              </div>
            </div>
          </div>

          <Button size="lg" className="w-full" type="submit">
            Save changes
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
