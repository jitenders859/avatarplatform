"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
}

interface RecommendedInstructor {
  id: string;
  name: string;
  hourlyRateCents: number;
  currency: string;
  ratingAvg: number;
}

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [paywall, setPaywall] = useState<{ limit: number } | null>(null);
  const [instructors, setInstructors] = useState<RecommendedInstructor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<{ messages: Message[] }>(`/api/chat/sessions/${sessionId}/messages`)
      .then((res) => setMessages(res.messages))
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;
    setError(null);

    const userMessage: Message = { id: `local-${Date.now()}`, role: "USER", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);

    try {
      const res = await apiFetch<{ reply: string; recommendedInstructors: RecommendedInstructor[] }>(
        `/api/chat/sessions/${sessionId}/messages`,
        { method: "POST", body: JSON.stringify({ content: userMessage.content }) }
      );
      setMessages((prev) => [...prev, { id: `local-${Date.now()}-a`, role: "ASSISTANT", content: res.reply }]);
      setInstructors(res.recommendedInstructors ?? []);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 402) {
        setPaywall({ limit: (err.payload as { limit: number })?.limit ?? 20 });
      } else {
        setError(err instanceof ApiClientError ? err.message : "Something went wrong");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="container section">
      <div className="chat-window">
        <div className="chat-messages">
          {messages.length === 0 && <p className="dim">Ask anything about your ground school syllabus to get started.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`chat-bubble ${m.role === "USER" ? "user" : "assistant"}`}>
              {m.content}
            </div>
          ))}
          {sending && <div className="chat-bubble assistant dim">Thinking…</div>}
          <div ref={bottomRef} />
        </div>

        {paywall && (
          <div className="paywall-banner">
            <strong>You&apos;ve used your {paywall.limit} free messages.</strong>
            <p className="dim">Subscribe to keep chatting with every ground-school bot on the platform.</p>
            <Link href="/pricing" className="btn">
              See plans
            </Link>
          </div>
        )}

        {!paywall && (
          <form onSubmit={onSubmit} className="chat-input-row">
            <textarea
              rows={2}
              placeholder="Type your question…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
            />
            <button className="btn" type="submit" disabled={sending || !input.trim()}>
              Send
            </button>
          </form>
        )}
      </div>

      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

      {instructors.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3>Want hands-on help? Talk to a real instructor.</h3>
          <p className="dim">Your first session with any of these instructors is free.</p>
          <div className="grid grid-3" style={{ marginTop: 12 }}>
            {instructors.map((i) => (
              <div className="card" key={i.id}>
                <strong>{i.name}</strong>
                <p className="dim">
                  ${(i.hourlyRateCents / 100).toFixed(0)}/hr · {i.ratingAvg > 0 ? `${i.ratingAvg.toFixed(1)}★` : "New"}
                </p>
                <Link href={`/instructors/${i.id}`} className="btn btn-secondary">
                  View profile
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
