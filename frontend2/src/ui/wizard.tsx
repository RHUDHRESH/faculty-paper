import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Check, LoaderCircle } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

/**
 * The shell for a multi-screen form, "File a paper" being the first tenant.
 *
 * This file owns the rail, the footer and how focus moves between screens.
 * It does not know a paper has a journal or a DOI — `steps` is just names and
 * hints, `children` is whatever the caller renders for the step in view. That
 * split is what lets the same shell serve a five-step submission today and a
 * three-step one next month without a second wizard being built.
 */
export type Step = {
  id: string;
  title: string;
  /** One line under the title saying what this step is for. */
  hint?: string;
  /**
   * Shown as "Optional" in the rail. The wizard does not skip it or relax
   * `validate` for it — that decision belongs to the caller, who knows
   * whether "optional" means "may be blank" or "may be filled in later".
   */
  optional?: boolean;
};

type RailState = "done" | "current" | "upcoming";

function railStateOf(index: number, current: number): RailState {
  if (index === current) return "current";
  return index < current ? "done" : "upcoming";
}

/* ------------------------------------------------------------------------ */
/* WizardStepHeading                                                        */
/* ------------------------------------------------------------------------ */

/**
 * The title and hint for the step in view, as its own piece.
 *
 * `Wizard` renders one of these itself, above `children`, and that covers
 * every step that just wants a plain heading. It is exported separately for
 * the step that does not — a review screen listing several sub-sections,
 * say, each wanting this exact title-plus-hint treatment repeated inside the
 * body rather than once above it.
 */
export const WizardStepHeading = forwardRef<
  HTMLHeadingElement,
  { title: string; hint?: string; optional?: boolean; className?: string }
>(function WizardStepHeading({ title, hint, optional, className }, ref) {
  return (
    <div className={cn("mb-6", className)}>
      <h2 ref={ref} tabIndex={-1} className="text-lg font-semibold">
        {title}
        {optional && (
          <span className="ml-2 align-middle text-sm font-normal text-fg-subtle">
            Optional
          </span>
        )}
      </h2>
      {hint && <p className="mt-1 text-base text-fg-muted">{hint}</p>}
    </div>
  );
});

/* ------------------------------------------------------------------------ */
/* Wizard                                                                    */
/* ------------------------------------------------------------------------ */

const SLIDE = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 16 : -16 }),
  center: { opacity: 1, x: 0 },
};

// motion's `transition` takes numbers, not CSS custom properties, so these
// mirror --dur-2 (140ms) and --ease-out from styles.css by value rather than
// by reference. If either token moves, move this to match.
const STEP_TRANSITION = { duration: 0.14, ease: [0.16, 1, 0.3, 1] as const };

export function Wizard({
  steps,
  current,
  onCurrentChange,
  onFinish,
  finishLabel = "Submit",
  busy = false,
  validate,
  furthest,
  children,
  className,
}: {
  steps: Step[];
  current: number;
  onCurrentChange: (index: number) => void;
  onFinish: () => void;
  finishLabel?: string;
  busy?: boolean;
  /** Return a message to block leaving this step, or null to allow it. */
  validate?: (index: number) => string | null;
  /** Steps the user has completed, so a revisited step can be jumped back to. */
  furthest?: number;
  children: ReactNode;
  className?: string;
}) {
  const isLast = current === steps.length - 1;
  // Guards a caller passing a stale `furthest` (e.g. left over from a reset
  // form) that is behind the step actually being shown.
  const reach = Math.max(furthest ?? current, current);

  const [direction, setDirection] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  // A step change moves focus to the new heading so a keyboard user lands
  // somewhere sensible instead of at the bottom of a page whose content just
  // changed under them. Skipped on mount: the page's own initial focus is
  // already fine, and grabbing it immediately would be the surprising thing.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [current]);

  // A step that failed `validate` keeps its message until the user actually
  // leaves it; a step reached any other way starts clean.
  useEffect(() => {
    setStepError(null);
  }, [current]);

  function go(index: number) {
    setDirection(index > current ? 1 : -1);
    onCurrentChange(index);
  }

  function handleBack() {
    if (current === 0) return;
    go(current - 1);
  }

  function handlePrimary() {
    const message = validate?.(current) ?? null;
    if (message) {
      setStepError(message);
      return;
    }
    if (isLast) {
      onFinish();
    } else {
      go(current + 1);
    }
  }

  function handleJump(index: number) {
    if (index === current || index > reach) return;
    // Jumping to a step already visited is a "go back and fix it" move, the
    // same as Back — it must not be blocked by whatever is wrong here now.
    go(index);
  }

  const activeStep = steps[current];

  return (
    <div className={cn("w-full", className)}>
      {/* Announces the step change even when the visible rail (desktop) or
          counter (mobile) does not itself re-render text a reader would
          otherwise have to notice by sight. */}
      <div aria-live="polite" className="sr-only">
        {activeStep &&
          `Step ${current + 1} of ${steps.length}: ${activeStep.title}`}
      </div>

      {/* Below md a five-item vertical rail would eat the screen, so it
          collapses to the one line that matters: where you are. */}
      <div className="mb-6 md:hidden">
        <p className="text-sm font-medium text-fg-muted">
          Step {current + 1} of {steps.length}
          {activeStep && <> — {activeStep.title}</>}
        </p>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-2)] ease-out"
            style={{ width: `${((current + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-8 md:flex-row md:items-start">
        <nav aria-label="Steps" className="hidden shrink-0 md:block md:w-52">
          <ol className="space-y-0.5">
            {steps.map((step, index) => {
              const state = railStateOf(index, current);
              const clickable =
                state === "done" || (state === "upcoming" && index <= reach);
              const disabled = index > reach;

              const inner = (
                <>
                  <span
                    className={cn(
                      "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium",
                      state === "done" && "bg-accent text-accent-fg",
                      state === "current" &&
                        "bg-accent-wash text-accent ring-1 ring-inset ring-accent-line",
                      state === "upcoming" &&
                        "text-fg-subtle ring-1 ring-inset ring-field",
                    )}
                  >
                    {state === "done" ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {step.title}
                      {step.optional && (
                        <span className="ml-1.5 font-normal text-fg-subtle">
                          Optional
                        </span>
                      )}
                    </span>
                    {step.hint && (
                      <span className="mt-0.5 block text-xs text-fg-muted">
                        {step.hint}
                      </span>
                    )}
                  </span>
                </>
              );

              const itemClass = cn(
                "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left",
                "transition-colors duration-[var(--dur-1)] ease-out",
              );

              return (
                <li key={step.id}>
                  {clickable ? (
                    // `clickable` never holds for the current step, so
                    // there is no "step" case to mark here — only the
                    // non-clickable branch below can render it.
                    <button
                      type="button"
                      onClick={() => handleJump(index)}
                      className={cn(itemClass, "cursor-pointer hover:bg-hover")}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div
                      aria-current={state === "current" ? "step" : undefined}
                      aria-disabled={disabled || undefined}
                      className={cn(
                        itemClass,
                        state === "current"
                          ? "bg-selected"
                          : "cursor-not-allowed opacity-60",
                      )}
                    >
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-w-0 flex-1">
          {/* Keyed on the step and animated in, with no exit and no
              `AnimatePresence`.

              `mode="wait"` reads better on paper — the old step slides out,
              then the new one slides in — but it holds the incoming step
              unmounted until the outgoing exit animation *finishes*. That
              makes the correctness of what is on screen depend on an
              animation running to completion, and animations do not always
              run: a background tab, a minimised window, a throttled frame
              loop. Verified here in a browser that is not compositing, where
              `requestAnimationFrame` never fires at all — the rail said step
              two, the live region said step two, and the body still showed
              step one, indefinitely.

              A form that files a payment claim cannot show the wrong step
              under any circumstance. So React swaps the subtree immediately
              and motion only animates the arrival. The cost is the outgoing
              slide, which lasted 140ms and which nobody will miss. */}
          <motion.div
            key={activeStep?.id ?? current}
            custom={direction}
            variants={SLIDE}
            initial="enter"
            animate="center"
            transition={STEP_TRANSITION}
          >
            {activeStep && (
              <WizardStepHeading
                ref={headingRef}
                title={activeStep.title}
                hint={activeStep.hint}
                optional={activeStep.optional}
              />
            )}
            {children}
          </motion.div>

          {stepError && (
            <p role="alert" className="mt-4 text-sm text-critical">
              {stepError}
            </p>
          )}

          <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
            <Button
              kind="default"
              size="lg"
              type="button"
              onClick={handleBack}
              disabled={current === 0 || busy}
            >
              Back
            </Button>
            <Button
              kind="primary"
              size="lg"
              type="button"
              onClick={handlePrimary}
              disabled={busy}
            >
              {busy && <LoaderCircle className="animate-spin" />}
              {isLast ? finishLabel : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
