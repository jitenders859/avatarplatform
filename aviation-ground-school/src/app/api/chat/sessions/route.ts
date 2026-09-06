import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

const bodySchema = z.object({
  chatbotSlug: z.string(),
});

/** GET /api/chat/sessions — the current student's chat sessions, most recent first. */
export async function GET() {
  try {
    const user = await requireUser();
    const sessions = await prisma.chatSession.findMany({
      where: { userId: user.id },
      include: { chatbot: { include: { country: true, licenseType: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json({ sessions });
  } catch (err) {
    return apiError(err);
  }
}

/** POST /api/chat/sessions — start (or resume) a chat with a given country/license chatbot. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { chatbotSlug } = bodySchema.parse(await req.json());

    const chatbot = await prisma.chatbot.findUnique({ where: { slug: chatbotSlug } });
    if (!chatbot || !chatbot.isActive) {
      return NextResponse.json({ error: "Unknown chatbot" }, { status: 404 });
    }

    let session = await prisma.chatSession.findFirst({
      where: { userId: user.id, chatbotId: chatbot.id },
      orderBy: { createdAt: "desc" },
    });

    if (!session) {
      session = await prisma.chatSession.create({
        data: { userId: user.id, chatbotId: chatbot.id },
      });
    }

    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
