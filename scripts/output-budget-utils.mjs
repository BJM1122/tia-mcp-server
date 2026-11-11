import assert from "node:assert/strict";

export function measure(name, result, enforce = true) {
  assert.ok(!result.isError && result.structuredContent?.ok !== false, name + " " + result.content[0].text.slice(0, 300));
  const size = result.content.map(item => item.text).join("").length;
  const largest = Object.entries(JSON.parse(result.content[0].text)).map(([field, value]) => [field, JSON.stringify(value).length])
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (enforce) assert.ok(size <= 10000, name + ": " + size + " characters; largest fields " + JSON.stringify(largest));
  console.log(name + ": " + size + " characters");
}
