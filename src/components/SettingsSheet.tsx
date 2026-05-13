import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backendUrl: string;
  onBackendUrlChange: (v: string) => void;
  useStreaming: boolean;
  onUseStreamingChange: (v: boolean) => void;
}

export function SettingsSheet({
  open,
  onOpenChange,
  backendUrl,
  onBackendUrlChange,
  useStreaming,
  onUseStreamingChange,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="font-mono">Settings</SheetTitle>
          <SheetDescription>Configure the backend connection.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-6 px-4">
          <div className="space-y-2">
            <Label htmlFor="backend" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Backend URL
            </Label>
            <Input
              id="backend"
              value={backendUrl}
              onChange={(e) => onBackendUrlChange(e.target.value.trim())}
              className="font-mono text-sm"
            />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div className="space-y-0.5">
              <Label className="text-sm">Streaming (SSE)</Label>
              <p className="text-xs text-muted-foreground">
                Use POST /chat. Off uses POST /ask.
              </p>
            </div>
            <Switch checked={useStreaming} onCheckedChange={onUseStreamingChange} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
