const { z } = require('zod');

/**
 * validate(schema) — express middleware factory.
 * Parses req.body against a Zod schema. On failure returns 400 with the
 * first error message and field name. On success replaces req.body with
 * the coerced, stripped output (unknown keys removed).
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = (result.error.issues ?? result.error.errors)[0];
      return res.status(400).json({
        error: first.message,
        field: first.path[0] ?? null,
      });
    }
    req.body = result.data;
    next();
  };
}

// ── Shared schemas ────────────────────────────────────────────
const email = z.string().email('Invalid email address').toLowerCase().trim();
const password = z.string().min(8, 'Password must be at least 8 characters');

const schemas = {
  signup: z.object({
    email,
    password,
    name: z.string().min(1, 'Name is required').max(80, 'Name too long').trim(),
  }),

  login: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),

  forgotPassword: z.object({
    email,
  }),

  resetPassword: z.object({
    token: z.string().min(1, 'Reset token is required'),
    newPassword: password,
  }),

  createProject: z.object({
    name: z.string().min(1, 'Name is required').max(120, 'Name too long').trim(),
    characterId: z.string().optional(),
  }),

  ask: z.object({
    question: z.string().min(1, 'question is required').max(1000, 'Question too long'),
    sessionId: z.string().optional(),
  }),

  log: z.object({
    role: z.enum(['user', 'assistant'], { error: 'role must be user or assistant' }),
    text: z.string().min(1, 'text is required').max(2000),
    sessionId: z.string().optional(),
  }),
};

module.exports = { validate, schemas, z };
