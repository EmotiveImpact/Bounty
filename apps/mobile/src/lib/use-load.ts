import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads something from the server for a screen, with pull-to-refresh.
 * data stays null until the first load works; error says why it did not.
 * A change of key loads again, for example a different item.
 */
export function useLoad<T>(load: () => Promise<T>, key = "") {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const run = useCallback(async () => {
    try {
      const value = await loader.current();
      if (live.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (live.current) setError((e as Error).message);
    }
    // key is the reason to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    live.current = true;
    const started = run();
    void started;
    return () => {
      live.current = false;
    };
  }, [run]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await run();
    if (live.current) setRefreshing(false);
  }, [run]);

  return { data, error, refreshing, refresh, reload: run };
}
