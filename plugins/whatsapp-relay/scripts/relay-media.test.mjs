import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { extractAttachment, collectMediaStream, downloadBoundedMedia } from "./relay-media.mjs";

test("wrapped document captions are preserved as data", () => {
  const attachment = extractAttachment({ ephemeralMessage: { message: { documentMessage: {
    fileName: "notes.txt", mimetype: "text/plain", fileLength: 12, caption: "/host vm"
  } } } });
  assert.deepEqual(attachment, { filename: "notes.txt", mimetype: "text/plain", size: 12, caption: "/host vm" });
  assert.equal(extractAttachment({ conversation: "hello" }), null);
});
test("media stream enforces actual bytes and destroys oversized input", async () => {
  const stream = Readable.from([Buffer.from("ab"), Buffer.from("cd")]);
  await assert.rejects(collectMediaStream(stream, { maxBytes: 3 }), /limit/);
  assert.equal(stream.destroyed, true);
  assert.equal((await collectMediaStream(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), { maxBytes: 4 })).toString(), "abcd");
});
test("stalled media streams time out and close", async () => {
  const stream = new PassThrough();
  // Keep the test event loop alive; the production timeout intentionally unrefs.
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(collectMediaStream(stream, { timeoutMs: 10 }), /timed out/); }
  finally { clearInterval(keepAlive); }
  assert.equal(stream.destroyed, true);
});
test("download setup timeout also destroys a stream arriving after its deadline", async () => {
  const stream = new PassThrough();
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(downloadBoundedMedia(() => delayed, { timeoutMs: 10 }), /timed out/);
    release(stream);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stream.destroyed, true);
  } finally { clearInterval(keepAlive); }
});
