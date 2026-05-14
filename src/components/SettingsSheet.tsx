import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backendUrl: string;
  onBackendUrlChange: (v: string) => void;
}

export function SettingsSheet({
  open,
  onOpenChange,
  backendUrl,
  onBackendUrlChange,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="font-mono">Settings</SheetTitle>
          <SheetDescription>Configure the chat backend connection.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-6 px-4">
          <div className="space-y-2">
            <Label htmlFor="backend" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Edge Function base URL
            </Label>
            <Input
              id="backend"
              value={backendUrl}
              onChange={(e) => onBackendUrlChange(e.target.value.trim())}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              The chat function lives at <code className="font-mono">{`{base}/chat`}</code>.
              Defaults to the deployed Supabase Edge Function. Point it at a local{" "}
              <code className="font-mono">supabase functions serve</code> instance to test changes.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
