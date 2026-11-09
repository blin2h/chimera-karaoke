//! Italian text → phoneme segments: Wiktionary's pronunciations (`public/data/it-dict.txt.gz`,
//! from `tools/build-dict-it.ts`) when loaded, spelling rules otherwise. Italian spelling is
//! nearly phonemic; what it hides (stress, open or closed e/o, s/z voicing) the dictionary gives.
//! Without it: stress on the written accent, else the penultimate syllable (antepenultimate for
//! a few verb endings), closed e/o, intervocalic s voiced (as in the north).
//! Doubled consonants are one long segment (`dur` set), as the IPA "ː" makes them.

use super::english::{Phrase, expand_digits, parse_dict, phrases};
use super::inventory::consonant_symbols;
use super::ipa::tokenize_ipa;
use super::syllables::WordSource;
use super::{Lang, Segment};
use std::collections::HashMap;

/// a doubled consonant (s): about twice a single one
const GEMINATE: f64 = 0.14;

/// clitics and short particles: unstressed in running speech (the accented forms, è sì là né sé
/// dì, are other words)
const FUNCTION_WORDS: &str = "il lo la i gli le un uno una di a da in con su per tra fra e ed o od ma se che non mi ti si ci vi ne del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle col coi";

/// endings stressed on the antepenultimate syllable (cantàvano, dìssero, possìbile)
const ANTEPENULT: [&str; 16] = ["avano", "evano", "ivano", "avamo", "evamo", "ivamo", "arono", "erono", "irono", "ebbero", "essero", "assero", "issero", "abile", "ibile", "evole"];

#[derive(Clone, Debug, Default)]
pub struct ItalianG2P {
    dict: Option<HashMap<String, String>>,
}

impl ItalianG2P {
    pub fn new() -> ItalianG2P {
        ItalianG2P::default()
    }

    pub fn is_loaded(&self) -> bool {
        self.dict.is_some()
    }

    /// "word\tIPA" lines (`public/data/it-dict.txt.gz` gunzipped).
    pub fn load_dict(&mut self, text: &str) {
        self.dict = Some(parse_dict(text));
    }

    /// Text → phrases of segments.
    pub fn to_phrases(&self, text: &str) -> Vec<Phrase> {
        phrases(text, expand_numbers, |c| c.is_alphabetic() || c == '\'' || c == '-', |w| self.word(w, true), |_| {})
    }

    fn lookup(&self, w: &str) -> Option<Vec<Segment>> {
        self.dict.as_ref()?.get(w).map(|ipa| tokenize_ipa(ipa))
    }

    /// One word → segments with lexical stress. `reduce`: clitics unstressed (speech).
    pub fn word(&self, w: &str, reduce: bool) -> Vec<Segment> {
        let lower = w.to_lowercase();
        let clean = lower.trim_matches('-');
        let mut segs = if let Some(s) = self.lookup(clean).or_else(|| self.lookup(clean.trim_matches('\''))) {
            s
        } else if let Some(k) = clean.trim_matches('\'').rfind('\'') {
            // elision: "l'amore", "dell'anima", "c'è": the clitic unstressed, then the word
            let clean = clean.trim_matches('\'');
            let (pre, post) = (&clean[..k], &clean[k + 1..]);
            let mut s = self.lookup(&format!("{pre}'")).unwrap_or_else(|| letter_to_sound(pre));
            s.iter_mut().for_each(|x| x.stress = Some(0));
            if pre.ends_with('c') && post.starts_with(['e', 'i', 'è', 'é', 'ì']) {
                if let Some(last) = s.last_mut() {
                    last.ipa = "tʃ".into();
                }
            }
            s.extend(self.word(post, false));
            s
        } else if clean.contains('-') {
            clean.split('-').flat_map(|p| self.word(p, reduce)).collect()
        } else {
            letter_to_sound(clean)
        };
        if reduce && FUNCTION_WORDS.split(' ').any(|f| f == clean) {
            segs.iter_mut().for_each(|s| s.stress = Some(0));
        }
        // /n/ takes the place of a following velar ("anche" → aŋke)
        for i in 1..segs.len() {
            if segs[i - 1].ipa == "n" && (segs[i].ipa == "k" || segs[i].ipa == "g") {
                segs[i - 1].ipa = "ŋ".into();
            }
        }
        let mut segs = merge_geminates(segs);
        // a single /r/ between vowels is a tap ("amore"); doubled, or next to a consonant, a trill
        for i in 1..segs.len().saturating_sub(1) {
            if segs[i].ipa == "r" && segs[i].dur.is_none() && !is_consonant(&segs[i - 1].ipa) && !is_consonant(&segs[i + 1].ipa) {
                segs[i].ipa = "ɾ".into();
            }
        }
        for s in segs.iter_mut() {
            s.lang = Some(Lang::It);
        }
        segs
    }
}

impl WordSource for ItalianG2P {
    fn word(&self, w: &str, reduce: bool) -> Vec<Segment> {
        ItalianG2P::word(self, w, reduce)
    }
    fn italian(&self) -> bool {
        true
    }
}

fn is_consonant(ipa: &str) -> bool {
    consonant_symbols().contains(&ipa)
}

/// A consonant said twice in a row ("tt", or "t"+"ts" as the dictionary writes "zz") → one long one.
fn merge_geminates(segs: Vec<Segment>) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::with_capacity(segs.len());
    for s in segs {
        if let Some(p) = out.last_mut()
            && p.dur.is_none()
            && p.word_end != Some(true)
            && is_consonant(&s.ipa)
            && (p.ipa == s.ipa || matches!((p.ipa.as_str(), s.ipa.as_str()), ("t", "ts" | "tʃ") | ("d", "dz" | "dʒ")))
        {
            *p = Segment { dur: Some(GEMINATE), ..s };
            continue;
        }
        out.push(s);
    }
    out
}

// ---------------------------------------------------------------- spelling rules
fn vowel_letter(c: char) -> bool {
    "aeiouàáèéìíîòóùú".contains(c)
}
fn front(c: char) -> bool {
    "eièéìí".contains(c)
}
/// an accented vowel letter: the stressed vowel it spells
fn accented(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' => "a",
        'è' => "ɛ",
        'é' => "e",
        'ì' | 'í' | 'î' => "i",
        'ò' => "ɔ",
        'ó' => "o",
        'ù' | 'ú' => "u",
        _ => return None,
    })
}

/// Spelling → segments with stress, for words the dictionary lacks.
pub fn letter_to_sound(word: &str) -> Vec<Segment> {
    let w: Vec<char> = word.to_lowercase().chars().filter(|c| c.is_alphabetic()).collect();
    let at = |k: usize| w.get(k).copied().unwrap_or(' ');
    let mut out: Vec<Segment> = Vec::new();
    // a doubled letter: the next consonant is said twice (merged into one long one below)
    let mut double = false;
    let mut i = 0;
    while i < w.len() {
        let (c, n, n2) = (w[i], at(i + 1), at(i + 2));
        let prev_v = i > 0 && vowel_letter(w[i - 1]);
        if vowel_letter(c) {
            let (ipa, stress) = if let Some(a) = accented(c) {
                (a, 1)
            } else if (c == 'i' || c == 'u') && vowel_letter(n) {
                // unstressed i/u before a vowel glide ("piano", "uomo", "quando")
                (if c == 'i' { "j" } else { "w" }, 0)
            } else if c == 'i' && i + 1 == w.len() && i > 0 && "aeo".contains(w[i - 1]) {
                ("j", 0) // "mai", "poi", "sei"
            } else {
                (match c { 'e' => "e", 'o' => "o", 'i' => "i", 'u' => "u", _ => "a" }, 0)
            };
            out.push(Segment { ipa: ipa.into(), stress: Some(stress), ..Default::default() });
            i += 1;
            continue;
        }
        if c == n || (c == 'c' && n == 'q') {
            double = true;
            i += 1;
            continue;
        }
        let (ph, adv): (&[&str], usize) = match c {
            'c' if n == 'h' => (&["k"], 2),
            'c' if front(n) => (&["tʃ"], if n == 'i' && vowel_letter(n2) { 2 } else { 1 }),
            'g' if n == 'h' => (&["g"], 2),
            'g' if n == 'n' => (&["ɲ"], 2),
            'g' if n == 'l' && n2 == 'i' => (&["ʎ"], if vowel_letter(at(i + 3)) { 3 } else { 2 }),
            'g' if front(n) => (&["dʒ"], if n == 'i' && vowel_letter(n2) { 2 } else { 1 }),
            's' if n == 'c' && front(n2) => (&["ʃ"], if n2 == 'i' && vowel_letter(at(i + 3)) { 3 } else { 2 }),
            's' if "bdglmnrv".contains(n) || (prev_v && vowel_letter(n)) => (&["z"], 1),
            'z' if i == 0 => (&["dz"], 1),
            'z' => (&["ts"], 1),
            'c' | 'k' | 'q' => (&["k"], 1),
            'x' => (&["k", "s"], 1),
            'y' => (&["i"], 1),
            'b' => (&["b"], 1),
            'd' => (&["d"], 1),
            'f' => (&["f"], 1),
            'g' => (&["g"], 1),
            'j' => (&["j"], 1),
            'l' => (&["l"], 1),
            'm' => (&["m"], 1),
            'n' => (&["n"], 1),
            'p' => (&["p"], 1),
            'r' => (&["r"], 1),
            's' => (&["s"], 1),
            't' => (&["t"], 1),
            'v' => (&["v"], 1),
            'w' => (&["w"], 1),
            _ => (&[], 1), // h, and letters Italian does not use
        };
        // ʎ ɲ ʃ ts dz are long between vowels whether written double or not
        let long = double || (prev_v && vowel_letter(at(i + adv)) && ph.len() == 1 && ["ʎ", "ɲ", "ʃ", "ts", "dz"].contains(&ph[0]));
        for (k, p) in ph.iter().enumerate() {
            out.push(Segment { ipa: p.to_string(), stress: Some(0), ..Default::default() });
            if long && k == 0 {
                out.push(Segment { ipa: p.to_string(), stress: Some(0), ..Default::default() });
            }
        }
        double = false;
        i += adv;
    }
    // stress: a written accent, else the penultimate vowel (antepenultimate for some endings)
    let nuclei: Vec<usize> = out.iter().enumerate().filter(|(_, s)| !is_consonant(&s.ipa)).map(|(k, _)| k).collect();
    if !out.iter().any(|s| s.stress == Some(1)) && !nuclei.is_empty() {
        let back = if nuclei.len() >= 3 && ANTEPENULT.iter().any(|e| word.ends_with(e)) { 3 } else { 2.min(nuclei.len()) };
        out[nuclei[nuclei.len() - back]].stress = Some(1);
    }
    merge_geminates(out)
}

// ---------------------------------------------------------------- numbers
const UNITS: [&str; 20] = ["zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"];
const TENS: [&str; 10] = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];
/// a compound's last part ("tre" is stressed at the end of one: ventitré)
fn tail(n: u64) -> String {
    match n {
        0 => String::new(),
        3 => "tré".into(),
        _ => numero(n),
    }
}
fn numero(n: u64) -> String {
    match n {
        0..20 => UNITS[n as usize].into(),
        20..100 => {
            let (t, u) = (TENS[(n / 10) as usize], n % 10);
            // the tens drop their vowel before uno and otto (ventuno, trentotto)
            if u == 1 || u == 8 { format!("{}{}", &t[..t.len() - 1], UNITS[u as usize]) } else { format!("{t}{}", tail(u)) }
        }
        100..1000 => format!("{}cento{}", if n < 200 { "" } else { UNITS[(n / 100) as usize] }, tail(n % 100)),
        _ => format!("{} {}", if n < 2000 { "mille".into() } else { format!("{}mila", numero(n / 1000)) }, tail(n % 1000)),
    }
}
fn expand_numbers(t: &str) -> String {
    expand_digits(t, |d| match d.parse::<u64>() {
        Ok(n) if n < 1_000_000 => numero(n),
        _ => d.chars().filter_map(|c| c.to_digit(10)).map(|k| UNITS[k as usize]).collect::<Vec<_>>().join(" "),
    })
}
