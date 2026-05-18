import { Toaster } from 'sonner';

import { PlateEditor } from '@/components/editor/plate-editor';
import { TooltipProvider } from '@/components/ui/tooltip';

export default function Page() {
  return (
    <TooltipProvider>
      <div className="h-screen w-full">
        <PlateEditor />

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
