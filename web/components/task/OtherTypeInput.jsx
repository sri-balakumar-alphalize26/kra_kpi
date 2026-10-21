"use client";
import { Field, Input } from "@/components/ui";
import { DELIVERABLE_OTHER_MAX, DELIVERABLE_OTHER_PLACEHOLDER } from "@/lib/services/kpiActions";

/* The text box that appears when the task Type "Other" is picked: what the
   other type is (Plugin, Website, …). Required while Other is picked; the
   form checks it before saving and sends it as deliverable_other.
   `bare` drops the label, for a table cell. */
export default function OtherTypeInput({ value, onChange, bare, error, label = "Other type", style, autoFocus }) {
  const box = <Input value={value || ""} onChange={(e) => onChange(e.target.value.slice(0, DELIVERABLE_OTHER_MAX))} maxLength={DELIVERABLE_OTHER_MAX} placeholder={DELIVERABLE_OTHER_PLACEHOLDER} aria-label={label} autoFocus={autoFocus} style={{ ...(error ? { borderColor: "var(--danger)" } : null), ...style }} />;
  if (bare) return box;
  return <Field label={label} required error={error}>{box}</Field>;
}
