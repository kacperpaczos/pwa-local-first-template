import type { Component } from "solid-js";
import ModeToggle from "@/components/ModeToggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const AppearanceSection: Component = () => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Switch between light, dark, or system theme.</CardDescription>
      </CardHeader>
      <CardContent class="flex items-center justify-between gap-3">
        <p class="text-sm text-muted-foreground">Color mode</p>
        <ModeToggle />
      </CardContent>
    </Card>
  );
};

export default AppearanceSection;
