import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "../lib/utils";

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center rounded-md border border-border bg-muted/40 p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  // Radix's own default UNMOUNTS inactive content (`Presence` with
  // `present: forceMount || isSelected` — see @radix-ui/react-tabs's
  // Content implementation): without `forceMount`, switching tabs away
  // removes the DOM node entirely. That default is exactly what would break
  // panels that register side effects (e.g. legend registration) keyed off
  // panel-open rather than active-tab, since an unmount would incorrectly
  // tear those down. `forceMount` keeps every TabsContent mounted at all
  // times; Radix already applies `hidden` (a plain HTML attribute) to the
  // inactive one, and the `data-[state=inactive]:hidden` class below backs
  // that up so an inactive panel never paints even if `hidden` is overridden.
  <TabsPrimitive.Content
    ref={ref}
    forceMount
    className={cn(
      "mt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=inactive]:hidden",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
