import * as React from "react"
import {
  AlertTriangle,
  Check,
  FileText,
  Info,
  Minus,
  Plus,
  ShieldAlert,
  UploadCloud,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ *
 * Field — one labelled control with hint + error, consistent everywhere
 * ------------------------------------------------------------------ */

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
  className,
  action,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: React.ReactNode
  error?: string | null
  children: React.ReactNode
  className?: string
  action?: React.ReactNode
}) {
  const generatedId = React.useId()
  const base = htmlFor || generatedId
  const hintId = hint ? `${base}-hint` : undefined
  const errorId = error ? `${base}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined

  // Point the control at its own hint and error. Without this a screen reader
  // announces the error once when it appears and never again — returning to the
  // field reads only the label.
  const control =
    React.isValidElement(children) && describedBy
      ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
          "aria-describedby":
            [
              (children.props as Record<string, unknown>)["aria-describedby"],
              describedBy,
            ]
              .filter(Boolean)
              .join(" ") || undefined,
        })
      : children

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
          {label}
          {required ? (
            <span aria-hidden className="ml-0.5 text-destructive">
              *
            </span>
          ) : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </Label>
        {action}
      </div>
      {control}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-xs font-medium text-destructive"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      {/* Kept alongside the error, not replaced by it — the guidance is most
          useful at exactly the moment the field is wrong. */}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Grid that keeps fields on a sane measure instead of stretching edge to edge. */
export function FieldGrid({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("grid gap-x-5 gap-y-4 sm:grid-cols-2", className)}>{children}</div>
  )
}

export function FieldSpan({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn("sm:col-span-2", className)}>{children}</div>
}

/* ------------------------------------------------------------------ *
 * Callout — tinted guidance block
 * ------------------------------------------------------------------ */

const CALLOUT_TONES = {
  info: {
    wrap: "border-info/25 bg-surface-brand/60 text-foreground",
    icon: "text-info",
    Icon: Info,
  },
  warning: {
    wrap: "border-warning/35 bg-surface-warning/70 text-foreground",
    icon: "text-warning-foreground",
    Icon: AlertTriangle,
  },
  danger: {
    wrap: "border-destructive/30 bg-surface-danger/70 text-foreground",
    icon: "text-destructive",
    Icon: ShieldAlert,
  },
  success: {
    wrap: "border-success/30 bg-surface-success/70 text-foreground",
    icon: "text-success",
    Icon: Check,
  },
} as const

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof CALLOUT_TONES
  title?: string
  children?: React.ReactNode
  className?: string
}) {
  const t = CALLOUT_TONES[tone]
  return (
    <div className={cn("flex gap-3 rounded-xl border px-3.5 py-3 text-sm", t.wrap, className)}>
      <t.Icon className={cn("mt-0.5 size-4 shrink-0", t.icon)} />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-semibold leading-tight">{title}</p> : null}
        {children ? (
          <div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * ChoiceCards — radio group rendered as descriptive cards
 * ------------------------------------------------------------------ */

export type Choice<T extends string> = {
  value: T
  label: string
  description?: string
  badge?: string
}

export function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  name,
  columns = 1,
  className,
}: {
  options: Choice<T>[]
  value: T | ""
  onChange: (value: T) => void
  name: string
  columns?: 1 | 2 | 3
  className?: string
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const forward = e.key === "ArrowDown" || e.key === "ArrowRight"
    const back = e.key === "ArrowUp" || e.key === "ArrowLeft"
    if (!forward && !back) return
    e.preventDefault()
    const next = (index + (forward ? 1 : -1) + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={cn(
        "grid gap-2.5",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-3",
        className
      )}
    >
      {options.map((opt, i) => {
        const selected = value === opt.value
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!value && i === 0) ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "group relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all outline-none",
              "focus-visible:ring-3 focus-visible:ring-ring/30",
              selected
                ? "border-primary/60 bg-surface-brand shadow-[0_1px_0_0_var(--primary)_inset]"
                : "border-border bg-card hover:border-primary/35 hover:bg-muted/50"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                selected ? "border-primary bg-primary" : "border-muted-foreground/40"
              )}
            >
              {selected ? <Check className="size-2.5 text-primary-foreground" /> : null}
            </span>
            <span className="min-w-0 space-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium leading-tight text-foreground">
                  {opt.label}
                </span>
                {opt.badge ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {opt.badge}
                  </span>
                ) : null}
              </span>
              {opt.description ? (
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  {opt.description}
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * SegmentedControl — short, mutually exclusive option sets
 * ------------------------------------------------------------------ */

export function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-full flex-wrap gap-1 rounded-xl border border-border bg-muted/60 p-1",
        className
      )}
    >
      {options.map((opt) => {
        const selected = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-all outline-none",
              "focus-visible:ring-3 focus-visible:ring-ring/30",
              selected
                ? "bg-card text-foreground shadow-sm ring-1 ring-primary/25"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * NumberStepper
 * ------------------------------------------------------------------ */

export function NumberStepper({
  value,
  onChange,
  min = 1,
  max = 50,
  id,
  ariaLabel,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  id?: string
  ariaLabel?: string
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n))
  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-card p-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Minus />
      </Button>
      <input
        id={id}
        aria-label={ariaLabel}
        inputMode="numeric"
        className="w-12 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/\D/g, ""), 10)
          onChange(Number.isNaN(n) ? min : clamp(n))
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Plus />
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * TagInput — reference numbers like "14, 15, 57"
 * ------------------------------------------------------------------ */

export function TagInput({
  value,
  onChange,
  placeholder,
  id,
  numericOnly = false,
  invalid,
}: {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  id?: string
  numericOnly?: boolean
  invalid?: boolean
}) {
  const [draft, setDraft] = React.useState("")

  function commit(raw: string) {
    const parts = raw
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => (numericOnly ? /^\d+$/.test(p) : true))
    if (!parts.length) return
    const merged = Array.from(new Set([...value, ...parts]))
    onChange(merged)
    setDraft("")
  }

  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-2xl border bg-input/50 px-2 py-1.5 transition-[color,box-shadow] focus-within:ring-3 focus-within:ring-ring/30",
        invalid ? "border-destructive" : "border-transparent focus-within:border-ring"
      )}
      onClick={() => document.getElementById(id || "")?.focus()}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-lg bg-primary/12 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            className="rounded-sm opacity-60 transition-opacity hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onChange(value.filter((t) => t !== tag))
            }}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length ? "" : placeholder}
        inputMode={numericOnly ? "numeric" : "text"}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === " ") {
            e.preventDefault()
            commit(draft)
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * DateField — native date input
 *
 * Was a custom calendar popover with no typed entry: every day was its own tab
 * stop, and a user who already knew the date could not simply type it. The
 * native control brings keyboard entry, the mobile date wheel, locale
 * formatting, and screen-reader support for free.
 * ------------------------------------------------------------------ */

function toISO(d: Date) {
  const m = `${d.getMonth() + 1}`.padStart(2, "0")
  const day = `${d.getDate()}`.padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

export function DateField({
  value,
  onChange,
  id,
  invalid,
  maxToday = true,
  "aria-describedby": describedBy,
}: {
  value: string
  onChange: (iso: string) => void
  id?: string
  invalid?: boolean
  maxToday?: boolean
  "aria-describedby"?: string
}) {
  return (
    <input
      id={id}
      type="date"
      value={value}
      max={maxToday ? toISO(new Date()) : undefined}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "flex h-9 w-full items-center rounded-2xl border bg-input/50 px-3 text-sm",
        "transition-[color,box-shadow] outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
        invalid ? "border-destructive" : "border-transparent",
        !value && "text-muted-foreground"
      )}
    />
  )
}

/* ------------------------------------------------------------------ *
 * FileDropzone — multi PDF with size guard and per-file removal
 * ------------------------------------------------------------------ */

export type UploadedFileRef = {
  url: string
  filename: string
  size_bytes: number
}

export function formatBytes(bytes: number) {
  if (!bytes) return "—"
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileDropzone({
  files,
  onAdd,
  onRemove,
  max = 1,
  maxBytes = 10 * 1024 * 1024,
  busy,
  id,
  invalid,
}: {
  files: UploadedFileRef[]
  onAdd: (files: File[]) => void
  onRemove: (url: string) => void
  max?: number
  maxBytes?: number
  busy?: boolean
  id?: string
  invalid?: boolean
}) {
  const [dragging, setDragging] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const remaining = max - files.length
  const full = remaining <= 0

  const [rejected, setRejected] = React.useState<string[]>([])

  // Every rejection used to be silent: drop a 20 MB file or a .docx and nothing
  // happened at all. Say which file was refused and why.
  function accept(list: FileList | null) {
    if (!list) return
    const reasons: string[] = []
    const eligible = Array.from(list).filter((f) => {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
      if (!isPdf) {
        reasons.push(`${f.name} is not a PDF`)
        return false
      }
      if (f.size > maxBytes) {
        reasons.push(`${f.name} is ${formatBytes(f.size)} — the limit is ${formatBytes(maxBytes)}`)
        return false
      }
      return true
    })

    const room = Math.max(0, remaining)
    const picked = eligible.slice(0, room)
    if (eligible.length > room) {
      const dropped = eligible.length - room
      reasons.push(
        `${dropped} more file${dropped === 1 ? "" : "s"} not added — ${max} is the maximum`
      )
    }

    setRejected(reasons)
    if (picked.length) onAdd(picked)
  }

  return (
    <div className="space-y-2">
      {/* At capacity the dropzone used to vanish entirely, leaving no
          explanation of why nothing more could be added. */}
      {full ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
          {max === 1
            ? "One file is the limit. Remove it to upload a different one."
            : `All ${max} slots are used. Remove a file to add another.`}
        </p>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            accept(e.dataTransfer.files)
          }}
          className={cn(
            "flex flex-col items-center justify-center rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
            dragging
              ? "border-primary bg-surface-brand"
              : invalid
                ? "border-destructive/60 bg-surface-danger/40"
                : "border-border bg-muted/40 hover:border-primary/40"
          )}
        >
          <UploadCloud
            className={cn("mb-2 size-5", dragging ? "text-primary" : "text-muted-foreground")}
          />
          <p className="text-sm font-medium text-foreground">
            Drop PDF{max > 1 ? "s" : ""} here, or{" "}
            <button
              type="button"
              className="text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              browse
            </button>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            PDF only · max {formatBytes(maxBytes)} each
            {max > 1 ? ` · ${remaining} of ${max} remaining` : ""}
          </p>
          <input
            id={id}
            ref={inputRef}
            type="file"
            accept="application/pdf"
            multiple={max > 1}
            className="sr-only"
            onChange={(e) => {
              accept(e.target.files)
              e.target.value = ""
            }}
          />
        </div>
      )}

      {rejected.length ? (
        <ul role="alert" className="space-y-1">
          {rejected.map((message) => (
            <li
              key={message}
              className="flex items-start gap-1.5 text-xs font-medium text-destructive"
            >
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              {message}
            </li>
          ))}
        </ul>
      ) : null}

      {files.length ? (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li
              key={f.url}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-brand text-primary">
                <FileText className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                >
                  {f.filename || "Document.pdf"}
                </a>
                <span className="text-xs text-muted-foreground">{formatBytes(f.size_bytes)}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${f.filename}`}
                onClick={() => onRemove(f.url)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {busy ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * ReadOnlyField — profile-sourced values the faculty cannot edit
 * ------------------------------------------------------------------ */

export function ReadOnlyField({
  label,
  value,
  hint,
  mono,
  error,
}: {
  label: string
  value?: string | null
  hint?: React.ReactNode
  mono?: boolean
  error?: string | null
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      <div
        className={cn(
          "flex h-9 items-center rounded-2xl border px-3 text-sm",
          error ? "border-destructive/50 bg-surface-danger/40" : "border-border bg-muted/60",
          value ? "text-foreground" : "text-muted-foreground",
          mono && "font-mono tabular-nums"
        )}
      >
        {value || "Not set"}
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
