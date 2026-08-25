import { createListCollection } from '@ark-ui/react/select';
import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** A titled block in the sidebar, matching the rule-and-caption look of the original. */
export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-border border-b px-4 py-3.5', className)}>
      <h2 className="text-muted-foreground mb-2.5 flex items-center gap-2 text-[11px] font-medium tracking-[0.14em] uppercase">
        {title}
        <span className="bg-border h-px flex-1" aria-hidden />
      </h2>
      {children}
    </section>
  );
}

export function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mb-2 flex flex-wrap items-end gap-2', className)}>{children}</div>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground mt-1.5 text-[11.5px] leading-snug">{children}</p>;
}

export interface Option<T extends string> {
  value: T;
  label: string;
}

/** Ark's Select wants a collection and array values; this hides both. */
export function LabeledSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  testId,
}: {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  className?: string;
  testId?: string;
}) {
  const collection = useMemo(
    () => createListCollection({ items: options as Option<T>[] }),
    [options],
  );

  return (
    <div data-testid={testId} className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
        {label}
      </span>
      <Select
        collection={collection}
        value={[value]}
        onValueChange={(d) => {
          const next = d.value[0] as T | undefined;
          if (next) onChange(next);
        }}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} item={o}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
