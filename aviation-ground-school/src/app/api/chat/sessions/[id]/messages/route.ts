import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { generateChatbotReply } from "@/lib/claude";
import { findMatchingInstructors } from "@/lib/instructors";
import { isSubscriptionActive } from "@/lib/pricing";
import { env } from "@/lib/env";

const bodySchema = z.object({
  content: z.string().min(1).max(4000),
});

/** GET /api/chat/sessions/:id/messages — full transcript for one session. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const session = await prisma.chatSession.findUnique({
      where: { id: params.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ messages: session.messages, freeMessagesUsed: session.freeMessagesUsed });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * POST /api/chat/sessions/:id/messages — send a message and get the chatbot's reply.
 *
 * Free-trial gate: once freeMessagesUsed hits FREE_CHAT_MESSAGE_LIMIT, a student without
 * an active subscription gets a 402 instead of a reply, so the frontend can show the paywall.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const { content } = bodySchema.parse(await req.json());

    const session = await prisma.chatSession.findUnique({
      where: { id: params.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        chatbot: { include: { country: true, licenseType: true } },
      },
    });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const subscribed = isSubscriptionActive(user.subscription);
    if (!subscribed && session.freeMessagesUsed >= env.freeChatMessageLimit) {
      return NextResponse.json(
        {
          error: "Free message limit reached",
          code: "PAYWALL",
          freeMessagesUsed: session.freeMessagesUsed,
          limit: env.freeChatMessageLimit,
        },
        { status: 402 }
      );
    }

    await prisma.chatMessage.create({
      data: { sessionId: session.id, role: "USER", content },
    });

    const history = [...session.messages.map((m) => ({ role: m.role, content: m.content })), { role: "USER" as const, content }]
      .filter((m) => m.role !== "SYSTEM")
      .map((m) => ({ role: m.role.toLowerCase() as "user" | "assistant", content: m.content }));

    const replyText = await generateChatbotReply(session.chatbot.systemPrompt, history);

    const [, updatedSession] = await prisma.$transaction([
      prisma.chatMessage.create({ data: { sessionId: session.id, role: "ASSISTANT", content: replyText } }),
      prisma.chatSession.update({
        where: { id: session.id },
        data: subscribed ? { updatedAt: new Date() } : { freeMessagesUsed: { increment: 1 }, updatedAt: new Date() },
      }),
    ]);

    // Surface a couple of matching human instructors alongside the reply so the frontend
    // can render a "talk to an instructor" prompt without a second round trip.
    const recommendedInstructors = await findMatchingInstructors(
      session.chatbot.countryId,
      session.chatbot.licenseTypeId
    );

    return NextResponse.json({
      reply: replyText,
      freeMessagesUsed: updatedSession.freeMessagesUsed,
      freeMessagesRemaining: subscribed ? null : Math.max(0, env.freeChatMessageLimit - updatedSession.freeMessagesUsed),
      recommendedInstructors: recommendedInstructors.map((i) => ({
        id: i.id,
        name: i.user.name,
        hourlyRateCents: i.hourlyRateCents,
        currency: i.currency,
        ratingAvg: i.ratingAvg,
      })),
    });
  } catch (err) {
    return apiError(err);
  }
}
