// MCP tool result helpers shared by every tool module.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function textResult(text: string, structuredContent?: Record<string, JsonValue>) {
  return structuredContent
    ? { content: [{ type: "text" as const, text }], structuredContent }
    : { content: [{ type: "text" as const, text }] };
}

export function jsonResult(value: Record<string, JsonValue>) {
  return textResult(JSON.stringify(value), value);
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function assembledImportResult(result: { exitCode: number | null; stdout: string; stderr: string }, fields: Record<string, JsonValue>) {
  return jsonResult({
    ...fields,
    ...(result.exitCode === 0 && fields.summary ? {} : { stdout: truncate(result.stdout, 4_000).text }),
    stderr: truncate(result.stderr, 4_000).text
  });
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
