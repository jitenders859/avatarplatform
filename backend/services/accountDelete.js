const db = require('../db');
const logger = require('../logger').child({ module: 'accountDelete' });

// Cancel any live Stripe subscription first — FK CASCADE will delete our
// local subscriptions row along with the user, but Stripe itself keeps
// billing the customer until told to stop. Without this, a deleted
// account keeps getting charged with no way to log back in and cancel.
// FK CASCADE in Postgres handles deleting all related data automatically.
// Deleting the user row cascades: projects → files, chunks, sessions,
// messages, capture_fields, leads; also subscriptions, usage.
//
// Callers are responsible for authorization — this function performs NO
// permission check. It permanently deletes whichever user id it is given.
async function deleteUserAccount(userId) {
  const user = await db.findOne('users', { id: userId });
  if (!user) return;
  if (user.stripeCustomerId) {
    try {
      const { getStripe } = require('./stripe');
      const stripe = getStripe();
      if (stripe) {
        const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active', limit: 10 });
        await Promise.all(subs.data.map(s => stripe.subscriptions.cancel(s.id)));
      }
    } catch (e) {
      logger.warn({ err: e.message, userId }, 'failed to cancel Stripe subscription on account delete');
    }
  }
  await db.remove('users', { id: userId });
}

module.exports = { deleteUserAccount };
