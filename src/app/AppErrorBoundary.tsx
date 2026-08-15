import { ErrorBoundary as SolidErrorBoundary, type Component, type ParentProps } from "solid-js";
import { RefreshCw, RotateCcw } from "lucide-solid";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const AppErrorBoundary: Component<ParentProps> = (props) => {
  return (
    <SolidErrorBoundary
      fallback={(error, reset) => (
        <div class="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
          <Alert variant="destructive" class="text-left">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
          <p class="text-sm text-muted-foreground">
            Your notes are stored locally and are not affected by this error.
          </p>
          <div class="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={reset}>
              <RotateCcw class="size-4" />
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>
              <RefreshCw class="size-4" />
              Reload app
            </Button>
          </div>
        </div>
      )}
    >
      {props.children}
    </SolidErrorBoundary>
  );
};

export default AppErrorBoundary;
