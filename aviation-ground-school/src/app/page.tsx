import Link from "next/link";

const LICENSES = [
  { code: "PPL", name: "Private Pilot License" },
  { code: "CPL", name: "Commercial Pilot License" },
  { code: "ATPL", name: "Airline Transport Pilot License" },
  { code: "MULTI_ENGINE", name: "Multi-Engine Rating" },
  { code: "INSTRUMENT", name: "Instrument Rating" },
];

export default function HomePage() {
  return (
    <>
      <div className="hero container">
        <span className="badge">New</span>
        <h1>Ground school prep, tuned to your country and your license.</h1>
        <p>
          Pick your country and the license you&apos;re training for — PPL, CPL, ATPL, multi-engine, instrument — and
          chat with an AI ground-school instructor grounded in your regulator&apos;s rules. Free to start. Upgrade
          when you&apos;re ready, or book a real flight instructor for the parts a chatbot can&apos;t teach.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <Link href="/onboarding" className="btn">
            Start chatting free
          </Link>
          <Link href="/instructors" className="btn btn-secondary">
            Browse instructors
          </Link>
        </div>
      </div>

      <div className="section container">
        <h2>Licenses we cover</h2>
        <div className="grid grid-3" style={{ marginTop: 20 }}>
          {LICENSES.map((l) => (
            <div className="card" key={l.code}>
              <strong>{l.name}</strong>
              <p className="dim" style={{ margin: "8px 0 0" }}>
                Country-specific chatbots, e.g. US {l.code}, Canada {l.code}, UK {l.code}.
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="section container">
        <h2>How it works</h2>
        <div className="grid grid-3" style={{ marginTop: 20 }}>
          <div className="card">
            <strong>1. Pick your country + license</strong>
            <p className="dim">We route you to the chatbot trained on your regulator&apos;s rulebook.</p>
          </div>
          <div className="card">
            <strong>2. Chat for free</strong>
            <p className="dim">Ask questions, get quizzed, and drill weak spots — free for your first messages.</p>
          </div>
          <div className="card">
            <strong>3. Talk to a real instructor</strong>
            <p className="dim">
              Your first session with any instructor on the platform is free (up to 30 minutes). After that, pay
              their hourly rate plus a small platform fee — no subscription required for instructor time.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
