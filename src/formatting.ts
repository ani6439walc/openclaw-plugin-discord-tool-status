export function getToolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("📖")) return "";
  if (n.includes("web_search")) return "🔎";
  if (n.includes("web_fetch")) return "🗳️";
  if (n.includes("browser")) return "🌎";
  if (n.includes("memory")) return "🧠";
  if (n.includes("wiki")) {
    if (n.includes("search")) return "🕵️";
    if (n.includes("apply")) return "🧱";
    if (n.includes("lint")) return "🧼";
    if (n.includes("status")) return "📡";
    return "📒";
  }
  if (n.includes("deepwiki")) {
    if (n.includes("ask")) return "🐙";
    return "📚";
  }
  if (n.includes("context7")) {
    if (n.includes("resolve")) return "🧩";
    return "🗞️";
  }
  if (n.includes("google-developer")) {
    if (n.includes("search") || n.includes("answer")) return "🔭";
    return "📂";
  }
  if (n.includes("read")) return "📖";
  if (n.includes("write")) return "✍️";
  if (n.includes("edit")) return "🛠️";
  if (n.includes("diff")) return "⚖️";
  if (n.includes("exec")) return "🚀";
  if (n.includes("process")) return "⏳";
  if (n.includes("image_generate")) return "🧪";
  if (n.includes("image")) return "🖼️";
  if (n.includes("pdf")) return "📜";
  if (n.includes("message")) return "✉️";
  if (n.includes("sequential")) return "🔗";
  if (n.includes("session_status")) return "🎬";
  if (n.includes("sessions_history")) return "🕰️";
  if (n.includes("sessions_list")) return "🔖";
  if (n.includes("sessions_send")) return "🛸";
  if (n.includes("sessions_spawn")) return "🐣";
  if (n.includes("sessions_yield")) return "🏁";
  if (n.includes("agents_list") || n.includes("subagents")) return "👥";
  return "💡";
}

export function formatParams(params: any): string {
  if (!params || typeof params !== "object") return "";
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v], index) => {
      const keyPrefix = index === 0 ? "   - " : "     ";
      const valueIndent = index === 0 ? "      " : "      ";
      let val = typeof v === "string" ? v : JSON.stringify(v, null, 5);
      val = val.trim();

      if (val.includes("\n")) {
        let displayVal = val;
        if (displayVal.length > 1000) {
          displayVal = displayVal.substring(0, 1000) + "... (truncated)";
        }
        const lines = displayVal
          .split("\n")
          .map((line) => `${valueIndent}${line}`)
          .join("\n");
        return `${keyPrefix}${k}: |\n${lines}`;
      } else {
        if (val.length > 200) val = val.substring(0, 200) + "...";
        return `${keyPrefix}${k}: ${val}`;
      }
    })
    .join("\n")
    .replaceAll(/`/g, "ˋ");
}
