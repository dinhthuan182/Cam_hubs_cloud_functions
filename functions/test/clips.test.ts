import { test } from "node:test";
import assert from "node:assert/strict";
import { clipStoragePaths } from "../src/clips";

test("clipStoragePaths derives the clip + thumbnail object paths", () => {
  const paths = clipStoragePaths("cam-1", "evt-9");
  assert.equal(paths.clip, "clips/cam-1/evt-9.mp4");
  assert.equal(paths.thumb, "clips/cam-1/evt-9_thumb.jpg");
});
