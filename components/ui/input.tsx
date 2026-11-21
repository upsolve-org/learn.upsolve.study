import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-none border border-input bg-well px-3 py-1 text-base transition-[color,border-color,background-color,box-shadow] duration-150 ease-[var(--ease-smooth)] outline-none selection:bg-[var(--lh-accent)] selection:text-well file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "hover:border-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/60",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/30",
        className
      )}
      {...props}
    />
  )
}

export { Input }
