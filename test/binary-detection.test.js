"use strict";

/**
 * Telling a binary file from a text one.
 *
 * From an external review: the old check counted every byte >= 128 as
 * printable, which left control characters as the only bytes it could ever
 * find suspicious. A file of uniformly random bytes has about half its bytes
 * above 127, all excused, and scored near 15% against a 30% threshold - so
 * it read as text, and most binaries were handed to the model as text.
 *
 * High bytes are ordinary in UTF-8 and meaningless in a JPEG. Decoding is
 * what tells them apart.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { isProbablyBinary } = require("../dist/tools/util");

const repeat = (s, n) => Buffer.from(s.repeat(n), "utf8");

test("real text is text, in any script", () => {
  assert.equal(isProbablyBinary(repeat("hello world\n", 50)), false);
  assert.equal(isProbablyBinary(repeat("Привет, мир! Тест.\n", 40)), false, "cyrillic");
  assert.equal(isProbablyBinary(repeat("salom, dunyo — o'zbekcha\n", 40)), false, "uzbek");
  assert.equal(isProbablyBinary(repeat("build ok ✅ 🚀\n", 50)), false, "emoji");
  assert.equal(isProbablyBinary(Buffer.from("")), false, "an empty file is not binary");
});

test("binary is binary", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(200, 0x41),
  ]);
  assert.equal(isProbablyBinary(png), true, "PNG header");

  // The case the old check waved through: high bytes with no NUL.
  const spread = Buffer.alloc(4096);
  for (let i = 0; i < spread.length; i++) spread[i] = (i * 97 + 13) % 256 || 1;
  assert.equal(isProbablyBinary(spread), true, "high-byte noise without a NUL");

  assert.equal(isProbablyBinary(Buffer.from([0x41, 0x00, 0x42])), true, "a NUL still decides it");
});

test("a multi-byte character cut by the sample boundary is not corruption", () => {
  // The sample is the first 8 KB, which usually lands mid-character on a
  // longer file. That tail alone must not make a text file look binary.
  const big = Buffer.from("Привет ".repeat(4000), "utf8");
  assert.ok(big.length > 8192);
  assert.equal(isProbablyBinary(big), false);
});

test("bytes that are not valid UTF-8 count as binary", () => {
  // A deliberate trade-off: a latin-1 file cannot be read as text correctly -
  // decoding it can only produce replacement characters - so saying "binary"
  // is more honest than handing the model mojibake.
  assert.equal(isProbablyBinary(Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0xe8, 0xf1])), true);
});
