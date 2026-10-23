import { useEffect, useRef } from "react";

const focusable =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep keyboard navigation inside a modal and restore the opening control. */
export function useDialog(onClose: () => void) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const inactive = new Map<HTMLElement, boolean>();
    let branch: HTMLElement = element;
    while (branch.parentElement && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          inactive.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    document.body.style.overflow = "hidden";
    const controls = () =>
      [...element.querySelectorAll<HTMLElement>(focusable)].filter(
        (control) =>
          control.getClientRects().length && !control.closest("[inert]"),
      );
    const focusFirst = () => (controls()[0] || element).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === "Tab") {
        const targets = controls();
        const first = targets[0];
        const last = targets.at(-1);
        if (!first) {
          event.preventDefault();
          element.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            !element.contains(document.activeElement))
        ) {
          event.preventDefault();
          last!.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !element.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (!element.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    focusFirst();
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      for (const [sibling, inert] of inactive) sibling.inert = inert;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return dialog;
}
