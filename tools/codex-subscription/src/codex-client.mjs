import { buildUpstreamHeaders } from "./normalize.mjs";

export function createCodexClient({ responsesUrl, fetchImpl = globalThis.fetch }) {
  async function requestResponses({ body, credentials, sessionId, signal }) {
    return fetchImpl(responsesUrl, {
      method: "POST",
      headers: buildUpstreamHeaders(credentials, { sessionId }),
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  }

  return Object.freeze({ requestResponses });
}
