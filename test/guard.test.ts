import test from "node:test";
import assert from "node:assert/strict";
import { checkData } from "../src/guard.js";

test("accepts a normal preference", () => {
  assert.equal(checkData({ agent: "claude", model: "sonnet" }), null);
});

test("rejects a path field", () => {
  assert.equal(checkData({ path: "x" }), "forbidden_field");
});

test("rejects a Windows path value", () => {
  assert.equal(checkData({ note: "D:\\dev\\sample-repo" }), "forbidden_field");
});

test("rejects a nested credential field", () => {
  assert.equal(checkData({ a: { b: { apiKey: "x" } } }), "forbidden_field");
});

test("rejects a GitHub token value", () => {
  assert.equal(checkData({ note: "ghp_abcdefghijklmnop" }), "forbidden_field");
});

test("rejects raw agent output", () => {
  assert.equal(checkData({ stdout: "lots of text" }), "forbidden_field");
});

test("rejects anything over 64 KB", () => {
  assert.equal(checkData({ big: "x".repeat(70000) }), "too_large");
});