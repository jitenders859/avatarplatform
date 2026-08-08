// src/mount.ts
function mountAvatarWidget({ serverUrl, botId }) {
  if (typeof document === "undefined") return;
  if (document.querySelector(`script[data-bot="${botId}"]`)) return;
  const script = document.createElement("script");
  script.src = `${serverUrl.replace(/\/$/, "")}/js/embed-loader.js`;
  script.dataset.bot = botId;
  script.defer = true;
  document.body.appendChild(script);
}

// src/ask.ts
async function askAvatar({ serverUrl, botId, question, sessionId }) {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/embed/${encodeURIComponent(botId)}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}
export {
  askAvatar,
  mountAvatarWidget
};
//# sourceMappingURL=index.js.map