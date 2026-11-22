export function traceLink(query = "", conversationId?: string) {
  const params = new URLSearchParams({trace:query});
  if (conversationId) params.set("conversation", conversationId);
  return "/debug?" + params;
}

export function mapLink(conversationId?: string, sessionView = false) {
  const params = new URLSearchParams();
  if (conversationId) params.set("conversation", conversationId);
  if (sessionView) params.set("view", "session");
  return params.size ? "/debug?" + params : "/debug";
}
