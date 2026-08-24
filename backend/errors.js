/**
 * Marker class for errors whose message is safe to return to API clients
 * verbatim — a deliberate, user-facing rejection raised intentionally by
 * application code, as opposed to an internal/DB/Supabase/upstream-API
 * error bubbling up uncaught. The global error handler in server.js only
 * exposes `err.message` for instances of this class; everything else gets
 * logged in full server-side and replaced with a generic message.
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

module.exports = { AppError };
