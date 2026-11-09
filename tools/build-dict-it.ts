/**
 * Build the Italian pronunciation dictionary shipped to the browser, from Wiktionary (kaikki.org's
 * extraction, ~780 MB of JSON lines, streamed):
 *   curl -sS https://kaikki.org/dictionary/Italian/kaikki.org-dictionary-Italian.jsonl | bun tools/build-dict-it.ts
 * Output: public/data/it-dict.txt.gz (lines: "word<TAB>IPA", stress marked, syllable dots
 * dropped; the first pronunciation of the first entry with one), and its licence notice.
 * Inflected forms Wiktionary gives no pronunciation (most verb forms) are left to the rules.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

const dict = new Map<string, string>();
/** keys that came from a capitalised headword (a lowercase headword replaces them) */
const fromCapital = new Set<string>();
for await (const line of console) {
  if (!line) continue;
  const e = JSON.parse(line) as { word?: string; lang_code?: string; sounds?: { ipa?: string }[] };
  if (e.lang_code !== "it" || !e.word || !/^[\p{L}'][\p{L}'-]*$/u.test(e.word)) continue;
  const ipa = e.sounds?.find((s) => s.ipa?.startsWith("/"))?.ipa;
  if (!ipa) continue;
  const key = e.word.toLowerCase();
  const capital = key !== e.word;
  if (dict.has(key) && (capital || !fromCapital.has(key))) continue;
  dict.set(key, ipa.replace(/[/.‿()]/g, ""));
  if (capital) fromCapital.add(key);
  else fromCapital.delete(key);
}
const out = [...dict].map(([w, ipa]) => `${w}\t${ipa}`).sort();
mkdirSync("public/data", { recursive: true });
const gz = gzipSync(Buffer.from(out.join("\n"), "utf8"), { level: 9 });
writeFileSync("public/data/it-dict.txt.gz", gz);
writeFileSync(
  "public/data/IT-DICT-LICENSE.txt",
  `it-dict.txt.gz: Italian pronunciations from Wiktionary (https://en.wiktionary.org), extracted by
kaikki.org (https://kaikki.org/dictionary/Italian/), reduced to word and IPA by tools/build-dict-it.ts.

Wiktionary content is available under the Creative Commons Attribution-ShareAlike 4.0 License
(https://creativecommons.org/licenses/by-sa/4.0/); this file is shared under the same licence.
`,
);
console.log(`${out.length} words, ${(gz.length / 1024).toFixed(0)} KiB gzipped`);
