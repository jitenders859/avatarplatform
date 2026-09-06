import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { sendDueReminders, completeExpiredBookings } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/reminders — meant to be hit periodically by an external scheduler (e.g.
 * Vercel Cron, see vercel.json), not by users. Sends "starting soon" emails for sessions
 * inside the reminder window and sweeps any CONFIRMED booking whose session has ended into
 * COMPLETED. Requires `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [reminded, completed] = await Promise.all([sendDueReminders(), completeExpiredBookings()]);

  return NextResponse.json({ reminded, completed });
}
