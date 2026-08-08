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
  AvatarWidget: () => AvatarWidget,
  askAvatar: () => import_js2.askAvatar
});
module.exports = __toCommonJS(index_exports);

// src/AvatarWidget.tsx
var import_react = require("react");
var import_js = require("@avatar-platform/js");
function AvatarWidget({ serverUrl, botId }) {
  (0, import_react.useEffect)(() => {
    (0, import_js.mountAvatarWidget)({ serverUrl, botId });
  }, [serverUrl, botId]);
  return null;
}

// src/index.ts
var import_js2 = require("@avatar-platform/js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AvatarWidget,
  askAvatar
});
//# sourceMappingURL=index.cjs.map