import { useEffect } from "react";
import { useRevalidator } from "react-router";

/**
 * Revalidates the current route's loader on an interval while the page is open. Paused while the
 * tab isn't visible, and skipped whenever a revalidation (or the initial load) is already in
 * flight, so polls never stack up. Also catches up immediately when the tab becomes visible again.
 */
export function useRevalidateOnInterval(intervalMs: number) {
  const revalidator = useRevalidator();

  useEffect(() => {
    function revalidateIfIdle() {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }

    const intervalId = setInterval(revalidateIfIdle, intervalMs);

    // Catch up immediately on refocus rather than waiting out the rest of the interval.
    document.addEventListener("visibilitychange", revalidateIfIdle);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", revalidateIfIdle);
    };
    // revalidator's identity is stable across renders; re-running this effect on every
    // revalidator.state change would tear down and restart the interval on each poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);
}
