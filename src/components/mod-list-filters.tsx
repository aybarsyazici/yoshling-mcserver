"use client";
import { useId } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ModFilterOption } from "@/lib/mod-list-filters";

interface ChoiceFilter {
  label: string;
  value: string;
  options: readonly ModFilterOption[];
  onChange(value: string): void;
}
export function ModListFilters({
  searchLabel, placeholder, query, onQueryChange, filters, count, note, active, onReset, disabled = false,
}: {
  searchLabel: string;
  placeholder: string;
  query: string;
  onQueryChange(value: string): void;
  filters: ChoiceFilter[];
  count: string;
  note: string;
  active: boolean;
  onReset(): void;
  disabled?: boolean;
}) {
  const searchId = useId();
  return <div className="space-y-2 rounded-2xl bg-card/60 p-4 ring-1 ring-border">
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="min-w-0 flex-1 space-y-1.5 sm:min-w-56">
        <Label htmlFor={searchId} className="text-xs">{searchLabel}</Label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input id={searchId} type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={placeholder} disabled={disabled} className="pl-9" />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {filters.map((filter) => <div key={filter.label} className="min-w-0 flex-1 space-y-1.5 sm:flex-none">
          <p className="text-xs text-muted-foreground">{filter.label}</p>
          <Select items={filter.options} value={filter.value} disabled={disabled} onValueChange={(value) => {
            if (value && filter.options.some((option) => option.value === value)) filter.onChange(value);
          }}>
            <SelectTrigger aria-label={filter.label} className="w-full sm:min-w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{filter.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>)}
        <Button size="sm" variant="outline" onClick={onReset} disabled={disabled || !active}>Reset filters</Button>
      </div>
    </div>
    <p role="status" className="text-xs tabular-nums text-muted-foreground">{count}</p>
    <p className="text-xs text-muted-foreground">{note}</p>
  </div>;
}
