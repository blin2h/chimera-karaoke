/**
 * Italian through the wasm build with the shipped dictionary: the page's two G2Ps stay apart,
 * and lyrics split into Italian syllables.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";

await initEngine();
const { EnglishG2P, G2P, lyricsToSyllables } = await import("../src/wasm/engine.ts");
const it = new G2P("it");
it.setDictionaryText(gunzipSync(readFileSync(new URL("../public/data/it-dict.txt.gz", import.meta.url))).toString());
const en = new EnglishG2P();

const show = (segs: { ipa: string; stress?: number; dur?: number }[]) => segs.map((s) => (s.stress === 1 ? "ˈ" : "") + s.ipa + (s.dur ? "ː" : "")).join("");

test("the dictionary gives stress and vowels the spelling hides", () => {
  expect(show(it.word("tavolo"))).toBe("tˈavolo");
  expect(show(it.word("pesca"))).toBe("pˈɛska");
  expect(show(it.word("mezzo"))).toBe("mˈɛdzːo");
  // a form Wiktionary does not transcribe: the rules
  expect(show(it.word("cantavano"))).toBe("kantˈavano");
  // the English G2P is untouched
  expect(show(en.word("water"))).not.toContain("ˈa");
});

test("Italian lyrics", () => {
  const syl = lyricsToSyllables("Camminare, sì, cantare", "it");
  expect(syl.map((s) => s.text)).toEqual(["Cam", "mi", "na", "re", "sì", "can", "ta", "re"]);
  expect(syl[2].nucleus.stress).toBe(1);
  expect(syl[3].phraseEnd).toBe(true);
});
