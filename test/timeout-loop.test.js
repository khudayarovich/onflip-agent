"use strict";

/**
 * The turn that spent itself on one thing that could never work.
 *
 * From a real session: a Word document to export as PDF, on a machine where
 * Word's COM export never returned. The agent tried it four ways — direct
 * export, a retry wrapper, LibreOffice, SaveAs — two minutes killed at the
 * time limit each, and every attempt made the next one worse, because a
 * killed command does not take the Word process it started with it and that
 * process kept the document open.
 *
 * Identical-call detection could not see it: the four commands were not
 * identical, they were four spellings of one idea. Timeouts are the signal
 * that generalises, so they are counted on their own.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { looksMisdecoded } = require("../dist/tools/shell");

test("PowerShell's own parse errors are recognised as unreadable", () => {
  // They are written before the command runs, so the prelude that switches
  // the console to UTF-8 has not run yet: the text arrives in the OEM
  // codepage and reaches the model as replacement characters. A model that
  // cannot read its own syntax error cannot fix it, so it guesses.
  const bad = "\uFFFD \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD: \"@.\n    + CategoryInfo : ParserError";
  assert.equal(looksMisdecoded(bad), true);
});

test("and ordinary output in any language is left alone", () => {
  assert.equal(looksMisdecoded("Не удается найти путь к файлу"), false);
  assert.equal(looksMisdecoded("error: file not found"), false);
  assert.equal(looksMisdecoded("Fayl topilmadi"), false);
});

test("one stray replacement character in real output is not a mis-decode", () => {
  const mostlyFine = `a long line of perfectly good output with one \uFFFD in it somewhere`;
  assert.equal(looksMisdecoded(mostlyFine), false);
});

test("the older direction — UTF-8 read as a byte codepage — still counts", () => {
  assert.equal(looksMisdecoded("\u0420\u0406\u0420 mangled"), true);
});
