import type { ReactNode } from "react";

export function SummaryMetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}
