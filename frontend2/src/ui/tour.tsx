import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

import { Button } from "@/ui/button";

/**
 * A first-run tour: a small card that points at one real element at a time,
 * a few steps long, shown once per account.
 *
 * Faculty sign in a few times a month and office staff live in the app all
 * day, so the same tour script cannot assume both audiences see the same
 * page — a step whose target is not on the page is dropped rather than
 * shown pointing at empty space, and if nothing in the list resolves the
 * tour does not open at all. That is the one behaviour this file cannot get
 * wrong: a faculty account pointed at a staff-only queue would otherwise
 * show a glowing ring around nothing.
 *
 * `useTour` owns "once per account", in `localStorage`, entirely separately
 * from "does this element exist", which `Tour` owns. A run that resolved to
 * zero steps was never actually shown, so it is not marked seen — it tries
 * again next visit rather than being lost forever to a race with page data
 * that had not loaded yet when the tour mounted.
 */

type Side = "top" | "bottom" | "left" | "right";

export type TourStep = {
  /** CSS selector, or a `data-tour="x"` value, for the element to point at. */
  target: string;
  title: string;
  body: string;
  /** Where the card sits relative to the target. Falls back automatically if it will not fit. */
  side?: Side;
};

const CARD_W = 320;
const FALLBACK_CARD_H = 140;
const CARD_GAP = 10;
const RING_PAD = 4;
const VIEWPORT_MARGIN = 8;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const MOVE_DUR = 0.18;
const FADE_DUR = 0.16;

/** A bare word is a `data-tour` value; anything with selector syntax (`#`,
 *  `.`, `[`, a space) is used as-is, so a step can point at either without
 *  the tour needing to know which. */
function resolveTarget(target: string): HTMLElement | null {
  const selector = /^[\w-]+$/.test(target) ? `[data-tour="${target}"]` : target;
  return document.querySelector<HTMLElement>(selector);
}

const OPPOSITE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/**
 * Where the card sits: try the requested side, flip to its opposite if that
 * would run off the viewport, then clamp regardless — a flip can still not
 * be enough room (a target hard against a corner has no side that fits),
 * and a card a few pixels from its ideal spot beats one that is off-screen.
 */
function computePlacement(
  rect: DOMRect,
  preferred: Side,
  cardW: number,
  cardH: number,
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function fits(side: Side): boolean {
    if (side === "top") return rect.top - CARD_GAP - cardH >= VIEWPORT_MARGIN;
    if (side === "bottom")
      return rect.bottom + CARD_GAP + cardH <= vh - VIEWPORT_MARGIN;
    if (side === "left") return rect.left - CARD_GAP - cardW >= VIEWPORT_MARGIN;
    return rect.right + CARD_GAP + cardW <= vw - VIEWPORT_MARGIN;
  }

  const side = fits(preferred)
    ? preferred
    : fits(OPPOSITE[preferred])
      ? OPPOSITE[preferred]
      : preferred;

  let top: number;
  let left: number;
  if (side === "top" || side === "bottom") {
    top = side === "top" ? rect.top - CARD_GAP - cardH : rect.bottom + CARD_GAP;
    left = rect.left + rect.width / 2 - cardW / 2;
  } else {
    left =
      side === "left" ? rect.left - CARD_GAP - cardW : rect.right + CARD_GAP;
    top = rect.top + rect.height / 2 - cardH / 2;
  }

  const maxTop = Math.max(VIEWPORT_MARGIN, vh - cardH - VIEWPORT_MARGIN);
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - cardW - VIEWPORT_MARGIN);
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop);
  left = Math.min(Math.max(left, VIEWPORT_MARGIN), maxLeft);

  return { top, left };
}

/** Four rectangles around the target rather than one full-screen wash with
 *  a hole cut in it — same result as an SVG mask, without needing one. */
function DimRects({ rect }: { rect: DOMRect }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = Math.max(rect.top - RING_PAD, 0);
  const bottom = Math.min(rect.bottom + RING_PAD, vh);
  const left = Math.max(rect.left - RING_PAD, 0);
  const right = Math.min(rect.right + RING_PAD, vw);
  const bandHeight = Math.max(bottom - top, 0);

  const rects = [
    { top: 0, left: 0, width: vw, height: top },
    { top: bottom, left: 0, width: vw, height: Math.max(vh - bottom, 0) },
    { top, left: 0, width: left, height: bandHeight },
    { top, left: right, width: Math.max(vw - right, 0), height: bandHeight },
  ];

  return (
    <>
      {rects.map((r, i) => (
        <motion.div
          key={i}
          className="pointer-events-none fixed bg-black/40"
          initial={false}
          animate={r}
          transition={{ duration: MOVE_DUR, ease: EASE_OUT }}
        />
      ))}
    </>
  );
}

/**
 * The tour itself. Controlled: the caller owns `open` (normally via
 * `useTour`) and this component only ever asks to close it, via `onClose`
 * (skip, Escape, or the last step's "Done") and separately `onDone` (only
 * the last case) so a caller that cares about completion, as opposed to
 * dismissal, can tell them apart.
 */
export function Tour({
  steps,
  open,
  onClose,
  onDone,
}: {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
  /** Called when the run is finished rather than skipped. */
  onDone?: () => void;
}) {
  const [resolvedSteps, setResolvedSteps] = useState<TourStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();

  const showing = open && resolvedSteps.length > 0;
  const step: TourStep | undefined = resolvedSteps[stepIndex];

  // `showing` means "a run is under way"; `visible` means "the card is on
  // screen". They are one render apart, because the card cannot be placed
  // until the target has been measured, and anything that needs to touch the
  // card itself has to wait for the second one.
  const visible = showing && !!step && !!targetRect && !!pos;

  // Resolve once per run, not once per render — a page's data can still be
  // loading when this mounts, and re-filtering on every render would let a
  // step blink in or out mid-tour as unrelated state elsewhere changes.
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      setResolvedSteps(steps.filter((s) => resolveTarget(s.target) != null));
      setStepIndex(0);
    }
    wasOpen.current = open;
  }, [open, steps]);

  // Measure the target, scroll it into view if it is not already fully
  // visible, and position the ring and card. useLayoutEffect, not
  // useEffect, so this runs before the browser paints — otherwise the ring
  // would visibly jump from wherever it last was to the right place on
  // every step.
  useLayoutEffect(() => {
    if (!showing || !step) return;
    const currentStep = step;
    const el = resolveTarget(currentStep.target);
    if (!el) return;

    // `el` as a parameter, not a closed-over variable, so the listeners
    // below (called later, asynchronously) keep the narrowed
    // `HTMLElement` type rather than the nullable return type of
    // `resolveTarget`.
    function measure(target: HTMLElement) {
      const rect = target.getBoundingClientRect();
      setTargetRect(rect);
      const cardH = cardRef.current?.offsetHeight ?? FALLBACK_CARD_H;
      setPos(
        computePlacement(rect, currentStep.side ?? "bottom", CARD_W, cardH),
      );
    }

    const initial = el.getBoundingClientRect();
    const fullyVisible =
      initial.top >= 0 &&
      initial.left >= 0 &&
      initial.bottom <= window.innerHeight &&
      initial.right <= window.innerWidth;
    if (!fullyVisible) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    measure(el);

    const onMove = () => measure(el);
    window.addEventListener("scroll", onMove, { passive: true, capture: true });
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [showing, step]);

  // Focus moves in once, when the card appears, and back to whatever had it
  // once the run ends — not re-stolen on every step, which would fight a
  // reader who is tabbing through Back/Next.
  //
  // Keyed on `visible` rather than `showing`: on the render where `showing`
  // first turns true the target has not been measured yet, so the card is not
  // in the DOM and `cardRef.current` is null. Focus would silently never move,
  // and Tab from there would walk the page behind the tour.
  useLayoutEffect(() => {
    if (!visible) return;
    const previous = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => previous?.focus?.();
  }, [visible]);

  function skip() {
    onClose();
  }

  function back() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  function next() {
    if (stepIndex >= resolvedSteps.length - 1) {
      onDone?.();
      onClose();
    } else {
      setStepIndex((i) => i + 1);
    }
  }

  // A window listener rather than a handler on the card: the backdrop is
  // deliberately click-through (see the render below), so focus can end up
  // outside the card without the tour having closed, and Escape/arrows
  // should still work.
  useEffect(() => {
    if (!showing) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") skip();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, stepIndex, resolvedSteps.length]);

  // The portal is on the outside and `AnimatePresence` on the inside, not the
  // other way round. `AnimatePresence` tracks its children by key to know what
  // is leaving, and a `createPortal` result is not a child it can track — wrap
  // the portal in it and it renders nothing at all, silently, with every guard
  // above satisfied and no error anywhere.
  return createPortal(
    <AnimatePresence>
      {visible && step && targetRect && pos && (
        <motion.div
          key="tour"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: FADE_DUR }}
          className="fixed inset-0 z-50"
        >
          {/* Dims the page but never the target, and never blocks a click
                from reaching it either — the tour points at the page, it
                does not replace it (hence `aria-modal="false"` below). */}
          <DimRects rect={targetRect} />

          <motion.div
            className="pointer-events-none fixed rounded-md ring-2 ring-accent"
            initial={false}
            animate={{
              top: targetRect.top - RING_PAD,
              left: targetRect.left - RING_PAD,
              width: targetRect.width + RING_PAD * 2,
              height: targetRect.height + RING_PAD * 2,
            }}
            transition={{ duration: MOVE_DUR, ease: EASE_OUT }}
          />

          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="fixed rounded-lg bg-surface p-4 shadow-pop outline-none"
            style={{ width: CARD_W }}
            initial={false}
            animate={{ top: pos.top, left: pos.left }}
            transition={{ duration: MOVE_DUR, ease: EASE_OUT }}
          >
            {/* Keyed and animated in, with no exit and no `AnimatePresence`.
                  `mode="wait"` would hold the incoming title and body
                  unmounted until the outgoing exit animation finished, so a
                  frame loop that is throttled or stopped — a background tab, a
                  browser not compositing the page — leaves the footer reading
                  "Step 2 of 4" above wording that still describes step 1.
                  Explaining the wrong thing is the one failure a tour cannot
                  have. */}
            <motion.div
              key={stepIndex}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: FADE_DUR, ease: EASE_OUT }}
            >
              <h2 id={titleId} className="text-base font-semibold">
                {step.title}
              </h2>
              <p className="mt-1.5 text-sm text-fg-muted">{step.body}</p>
            </motion.div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <Button kind="quiet" size="sm" onClick={skip}>
                Skip
              </Button>
              <span className="text-xs text-fg-subtle">
                Step {stepIndex + 1} of {resolvedSteps.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  kind="default"
                  size="sm"
                  onClick={back}
                  disabled={stepIndex === 0}
                >
                  Back
                </Button>
                <Button kind="primary" size="sm" onClick={next}>
                  {stepIndex === resolvedSteps.length - 1 ? "Done" : "Next"}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * Reads and writes `localStorage["tour:<key>"]` so a tour a user has
 * finished — or skipped, which counts the same as finished — does not come
 * back on their next visit. `start()` bypasses that check entirely, which
 * is what a "Show me around again" menu item calls: a deliberate re-run is
 * a different event from a first run and should not be gated on it.
 */
export function useTour(key: string) {
  const storageKey = `tour:${key}`;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(storageKey) != null;
    } catch {
      // Storage can throw in a locked-down browsing mode; treat that as
      // "already seen" so the tour fails quiet rather than loud.
    }
    if (!seen) setOpen(true);
  }, [storageKey]);

  function start() {
    setOpen(true);
  }

  function close() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // See above — losing the "seen" flag only means it may show again.
    }
    setOpen(false);
  }

  return { open, start, close };
}
