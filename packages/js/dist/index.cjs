"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  askAvatar: () => askAvatar,
  mountAvatarWidget: () => mountAvatarWidget
});
module.exports = __toCommonJS(index_exports);

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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  askAvatar,
  mountAvatarWidget
});
//# sourceMappingURL=index.cjs.map