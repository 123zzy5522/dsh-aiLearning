/**
 * Public SDK surface for the ailearn host.
 *
 * Everything under `sdk/` is importable from three places and only these three:
 * the host, the client bundle, and third-party plugin packs. Keep it free of
 * Node and React specifics so all three can load it.
 */

export {
  API_VERSION,
  BUILD_STATE,
  BUILD_MODE,
  SETTLED_BUILD_STATES,
  isSettledBuild,
} from "./protocol.js";

export { CODES, errorBody } from "./codes.js";
