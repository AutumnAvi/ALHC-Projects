import {
  Calendar,
  CircleChevronDown,
  Columns3,
  Hash,
  ListChecks,
  SquareCheck,
  Type,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { FieldDef, FieldType } from "@/lib/fields";

const TYPE_ICONS: Record<FieldType, LucideIcon> = {
  text: Type,
  number: Hash,
  date: Calendar,
  boolean: SquareCheck,
  single_select: CircleChevronDown,
  multi_select: ListChecks,
  people: Users,
};

// The small icon in front of a field's name (Fields list, Customize → Fields, the field library, and since
// Nov 2 notes (batch 14, 96) the bulk bar's Field picker). One map, so every place shows the same icon.
export function FieldTypeIcon({
  field,
  className = "size-4",
}: {
  field: Pick<FieldDef, "fieldType" | "boundToSections">;
  className?: string;
}) {
  const Icon = field.boundToSections ? Columns3 : TYPE_ICONS[field.fieldType];
  return <Icon className={`shrink-0 text-zinc-500 ${className}`} aria-hidden />;
}
