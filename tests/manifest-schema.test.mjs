import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "openclaw.plugin.json"), "utf8"));
const schema = manifest.channelConfigs["openclaw-gmail"].schema;
const accountSchema = schema.properties.accounts.additionalProperties;

test("manifest channel config schema accepts OpenClaw group access fields", () => {
  assert.ok(schema.properties.groupPolicy, "top-level groupPolicy should be declared");
  assert.ok(schema.properties.groupAllowFrom, "top-level groupAllowFrom should be declared");
  assert.ok(accountSchema.properties.groupPolicy, "account groupPolicy should be declared");
  assert.ok(accountSchema.properties.groupAllowFrom, "account groupAllowFrom should be declared");
});
