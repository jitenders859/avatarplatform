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

// src/AvatarWidget.ts
var import_vue = require("vue");
var import_js = require("@avatar-platform/js");
var AvatarWidget = (0, import_vue.defineComponent)({
  name: "AvatarWidget",
  props: {
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: { type: String, required: true },
    /** Your project's public ID. */
    botId: { type: String, required: true }
  },
  setup(props) {
    (0, import_vue.onMounted)(() => {
      (0, import_js.mountAvatarWidget)({ serverUrl: props.serverUrl, botId: props.botId });
    });
    return () => null;
  }
});

// src/index.ts
var import_js2 = require("@avatar-platform/js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AvatarWidget,
  askAvatar
});
//# sourceMappingURL=index.cjs.map