import test from "node:test";
import assert from "node:assert/strict";
import jiti from "jiti";

const require = jiti(import.meta.url);
const { parseEmailAddress, headerValue, decodeB64Url, extractBody } = require("../src/utils.ts");

test("parseEmailAddress extracts address", () => {
  assert.equal(parseEmailAddress("Jane Doe <jane@example.com>"), "jane@example.com");
  assert.equal(parseEmailAddress("BOB@EXAMPLE.COM"), "bob@example.com");
});

test("headerValue finds header case-insensitively", () => {
  const headers = [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "Hi" }];
  assert.equal(headerValue(headers, "from"), "a@b.com");
  assert.equal(headerValue(headers, "Subject"), "Hi");
});

test("decodeB64Url decodes base64url", () => {
  assert.equal(decodeB64Url("SGVsbG8tX3dvcmxk"), "Hello-_world");
});

test("extractBody prefers text/plain and strips html fallback", () => {
  const payloadPlain = { parts: [{ mimeType: "text/plain", body: { data: "SGVsbG8h" } }] };
  assert.equal(extractBody(payloadPlain), "Hello!");

  const payloadHtml = { parts: [{ mimeType: "text/html", body: { data: "PGI+SGVsbG88L2I+" } }] };
  assert.equal(extractBody(payloadHtml), "Hello");
});
