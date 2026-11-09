"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A submit button that asks once before running an operator action, and
 * shows a working state while the server action runs.
 */
export function ConfirmButton({
  message,
  children,
  className = "button",
  pendingLabel = "Working…",
}: {
  message?: string;
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (message && !window.confirm(message)) {
          event.preventDefault();
        }
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
