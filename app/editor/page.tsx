import { Toaster } from 'sonner';

import { SignInPromptHost } from '@/components/auth/sign-in-prompt-host';
import { PlateEditor } from '@/components/editor/plate-editor';
import { TooltipProvider } from '@/components/ui/tooltip';

export default function Page() {
  return (
    <TooltipProvider>
      <div className="h-screen w-full">
        <PlateEditor />

        <SignInPromptHost />
        <Toaster closeButton />
      </div>
    </TooltipProvider>
  );
}
