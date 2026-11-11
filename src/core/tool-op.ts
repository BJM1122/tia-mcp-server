import { z } from "zod";
import { jsonResult } from "./results.js";

// One operation behind a merged tool. Its own schema validates the request and fills the
// defaults, so the tool's public schema only has to name the parameters.
export function op<S extends z.ZodRawShape, R>(shape: S, run: (args: z.output<z.ZodObject<S>>) => Promise<R>) {
  const schema = z.object(shape);
  return async (raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return jsonResult({ ok: false, status: "invalid_request",
        error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    }
    return run(parsed.data);
  };
}
