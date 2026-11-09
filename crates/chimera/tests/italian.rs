//! Italian G2P: the spelling rules, the dictionary path (a few Wiktionary entries), the lyrics.
use chimera::phonetics::Segment;
use chimera::phonetics::italian::ItalianG2P;
use chimera::anatomy::human::BodyMix;
use chimera::control::score::ControlKey;
use chimera::phonetics::Lang;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::phonetics::sing::{SongOptions, SungNote, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;

/// segments as IPA with ˈ before the stressed vowel and ː after a long consonant
fn show(xs: &[Segment]) -> String {
    xs.iter().map(|x| format!("{}{}{}", if x.stress == Some(1) { "ˈ" } else { "" }, x.ipa, if x.dur.is_some() { "ː" } else { "" })).collect()
}

#[test]
fn spelling_rules_without_the_dictionary() {
    for (w, want) in [
        ("gnocchi", "ɲˈokːi"),
        ("figlio", "fˈiʎːo"),
        ("scienza", "ʃˈentsa"),
        ("ciao", "tʃˈao"),
        ("giorno", "dʒˈorno"),
        ("chiesa", "kjˈeza"),
        ("acqua", "ˈakːwa"),
        ("città", "tʃitːˈa"),
        ("perché", "perkˈe"),
        ("pizza", "pˈitsːa"),
        ("zero", "dzˈeɾo"),
        ("anche", "ˈaŋke"),
        ("cantavano", "kantˈavano"),
        ("sbaglio", "zbˈaʎːo"),
        ("mai", "mˈaj"),
    ] {
        assert_eq!(show(&ItalianG2P::new().word(w, false)), want, "{w}");
    }
}

#[test]
fn dictionary_then_rules() {
    let mut g = ItalianG2P::new();
    g.load_dict("tavolo\tˈtavolo\nmezzo\tˈmɛdd͡zo\nc'è\tˈt͡ʃ‿ɛ\namore\taˈmore\nl'\tl");
    // the dictionary's stress and vowels; its "dd͡z" is one long dz
    assert_eq!(show(&g.word("tavolo", true)), "tˈavolo");
    assert_eq!(show(&g.word("Mezzo", true)), "mˈɛdzːo");
    assert_eq!(show(&g.word("c'è", true)), "tʃˈɛ");
    // elision: the clitic from the dictionary, unstressed, then the word
    assert_eq!(show(&g.word("l'amore", true)), "lamˈoɾe");
    // not in the dictionary: rules (penultimate stress)
    assert_eq!(show(&g.word("musica", true)), "muzˈika");
    // clitics are unstressed in speech, stressed alone in a song
    assert_eq!(show(&g.word("la", true)), "la");
    assert_eq!(show(&g.word("la", false)), "lˈa");
    let ph = g.to_phrases("Ventitré gatti, 1000 cani?");
    assert_eq!(ph.len(), 2);
    assert_eq!(ph[0].words, ["ventitré", "gatti"]);
    assert_eq!(ph[1].words, ["mille", "cani"]);
}

#[test]
fn lyrics() {
    let g = ItalianG2P::new();
    let syl = lyrics_to_syllables("Nel vento un canto, libertà", &g);
    let text: Vec<&str> = syl.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(text, ["Nel", "ven", "to", "un", "can", "to", "li", "ber", "tà"]);
    // Italian onsets: "ven.to", not "vent.o"; the accented à is part of the word
    assert_eq!(show(&syl[2].onset), "t");
    assert_eq!(show(&syl[1].coda), "n");
    assert!(syl[5].phrase_end);
    let syl = lyrics_to_syllables("tutto figlio sbaglio", &g);
    let text: Vec<&str> = syl.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(text, ["tut", "to", "fi", "glio", "sba", "glio"]);
}

/// the same segments, said as English
fn english(mut segs: Vec<Segment>) -> Vec<Segment> {
    segs.iter_mut().for_each(|s| s.lang = None);
    segs
}

#[test]
fn italian_stops_are_not_aspirated() {
    let it = ItalianG2P::new().word("tappo", true);
    let peak = |segs: &[Segment]| {
        let plan = plan_utterance(segs, &PlanOptions { body: BodyMix::MALE, ..Default::default() });
        plan.gestures.iter().filter(|g| g.label.as_ref().is_some_and(|l| l.as_str() == "aspiration")).filter_map(|g| g.targets.get(ControlKey::ABDUCTION)).fold(0.0, f64::max)
    };
    assert!(peak(&it) < 0.3, "{}", peak(&it));
    assert!(peak(&english(it)) > 0.3);
}

#[test]
fn italian_vowels_keep_their_length() {
    let plan = |segs: &[Segment]| plan_utterance(segs, &PlanOptions { body: BodyMix::MALE, ..Default::default() }).segments;
    let dur = |p: &[chimera::phonetics::PlannedSegment], k: usize| p[k].t1 - p[k].t0;
    // "caro": the unstressed vowel is not reduced as English would
    let it = ItalianG2P::new().word("caro", true);
    let (pi, pe) = (plan(&it), plan(&english(it)));
    assert!(dur(&pi, 3) > dur(&pe, 3));
    // "carro": a closed syllable, so a shorter vowel than in "caro"'s open one, and a long rr
    let rr = plan(&ItalianG2P::new().word("carro", true));
    assert!(dur(&pi, 1) > 1.2 * dur(&rr, 1), "{} vs {}", dur(&pi, 1), dur(&rr, 1));
    assert!(dur(&rr, 2) > 2.0 * dur(&pi, 2));
}

#[test]
fn a_sung_double_is_long() {
    let g = ItalianG2P::new();
    let consonant = |w: &str| {
        let syl = lyrics_to_syllables(w, &g);
        let notes: Vec<SungNote> = syl.into_iter().map(|syl| SungNote { midi: 60.0, beats: 1.0, syl }).collect();
        let plan = plan_song(&notes, &SongOptions { body: BodyMix::MALE, bpm: 100.0, ..Default::default() });
        // the word's second t: a double in "tutto"
        let s = plan.segments.iter().rev().find(|s| s.ipa == "t").expect("t");
        s.t1 - s.t0
    };
    assert!(consonant("tutto") > 1.5 * consonant("tuto"));
    assert_eq!(ItalianG2P::new().word("tutto", false)[0].lang, Some(Lang::It));
}

#[test]
fn italian_demo_songs_have_a_syllable_per_note() {
    for song in chimera::phonetics::songs::DEMO_SONGS.iter().filter(|s| s.lang == Some(Lang::It)) {
        assert_eq!(lyrics_to_syllables(song.lyrics, &ItalianG2P::new()).len(), song.notes.len(), "{}", song.name);
    }
}
