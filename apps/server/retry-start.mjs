// Share one startup attempt between concurrent requests. Keep a successful
// handler, but never cache a failed database connection/setup permanently.
export function retryStart(build, { log = console.error } = {}) {
  let handler;
  let starting;
  return async (req, res) => {
    if (!handler) {
      try {
        starting ||= Promise.resolve().then(build).then((ready) => (handler = ready))
          .finally(() => { starting = null; });
        await starting;
      } catch (error) {
        log("Bounty API not started: " + error.message);
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Bounty is temporarily unavailable. Please try again." }));
        return;
      }
    }
    return handler(req, res);
  };
}
