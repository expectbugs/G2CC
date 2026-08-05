# Phase A enrichment report — 2026-08-05

Tracks indexed: **2672**
Dupe clusters: **584** covering **1421** tracks
Lyrics cache rows: 1559 (480 with lyrics)
Qdrant `g2cc_music` points: 2672
Transcode cache: 2672 files, 7.87 GB

## Pass coverage

| pass | ok | failed | pending |
|---|---|---|---|
| tags | 2672 | 0 | 0 |
| musicbrainz | 2672 | 0 | 0 |
| lyrics | 2672 | 0 | 0 |
| audio | 2616 | 56 | 0 |
| profile | 2672 | 0 | 0 |
| embed | 2672 | 0 | 0 |
| dedupe | 2672 | 0 | 0 |
| pretranscode | 2672 | 0 | 0 |

## Field fill rates

- **genres**: 2672/2672 (100%)
- **styles**: 2672/2672 (100%)
- **moods**: 2672/2672 (100%)
- **energy**: 2672/2672 (100%)
- **bpm**: 2616/2672 (97%)
- **year**: 2325/2672 (87%)
- **vocals**: 2672/2672 (100%)
- **language**: 988/2672 (36%)
- **themes**: 2422/2672 (90%)
- **description**: 2672/2672 (100%)

## Top genres

vgm (1427), electronic (427), classic rock (426), hip hop (370), metal (339), rock (316), classical (313), unknown (219), soundtrack (180), progressive rock (136), folk (94), jazz (74), industrial (64), psychedelic rock (64), ambient (39), pop (37), spoken word (24), new age (21), funk (20), latin (12)

## Top moods

dark (718), driving (374), melancholic (320), tense (310), playful (307), aggressive (304), triumphant (232), dramatic (225), urgent (200), nostalgic (198), reflective (190), epic (185), ominous (182), brooding (174), warm (166), wistful (156), gritty (154), energetic (142), neutral (130), bittersweet (129)

## Top styles

ocremix (346), underground hip hop (252), boom bap (248), solo piano (243), arrangement (190), game arrange (175), ambient (170), game remix (161), political hip hop (148), art rock (147), orchestral (138), chiptune (128), industrial metal (119), cinematic (110), hard rock (104), instrumental rock (100), downtempo (90), prog rock (89), sound effect (89), symphonic (89)

## Failures (40 shown, 40/pass cap)

- `audio` #2569 sound.7.1.006.0001.001.ogg — decoded only 18630 samples
- `audio` #2570 sound.7.1.006.0001.002.ogg — decoded only 19271 samples
- `audio` #2571 sound.7.1.006.0001.003.ogg — decoded only 19592 samples
- `audio` #2572 sound.7.1.006.0001.004.ogg — decoded only 21035 samples
- `audio` #2573 sound.7.1.006.0001.005.ogg — decoded only 18710 samples
- `audio` #2574 sound.7.1.006.0001.006.ogg — decoded only 19776 samples
- `audio` #2575 sound.7.1.006.0002.001.ogg — decoded only 14642 samples
- `audio` #2576 sound.7.1.006.0002.002.ogg — decoded only 13563 samples
- `audio` #2577 sound.7.1.006.0002.003.ogg — decoded only 12912 samples
- `audio` #2578 sound.7.1.006.0002.004.ogg — decoded only 13400 samples
- `audio` #2579 sound.7.1.006.0002.005.ogg — decoded only 14323 samples
- `audio` #2580 sound.7.1.006.0002.006.ogg — decoded only 16523 samples
- `audio` #2581 sound.7.1.006.0003.001.ogg — decoded only 13753 samples
- `audio` #2582 sound.7.1.006.0003.002.ogg — decoded only 13621 samples
- `audio` #2583 sound.7.1.006.0003.003.ogg — decoded only 13753 samples
- `audio` #2584 sound.7.1.006.0003.004.ogg — decoded only 13753 samples
- `audio` #2585 sound.7.1.006.0003.005.ogg — decoded only 13753 samples
- `audio` #2586 sound.7.1.006.0003.006.ogg — decoded only 13293 samples
- `audio` #2587 sound.7.1.006.0004.001.ogg — decoded only 13102 samples
- `audio` #2588 sound.7.1.006.0004.002.ogg — decoded only 12346 samples
- `audio` #2589 sound.7.1.006.0004.003.ogg — decoded only 12591 samples
- `audio` #2590 sound.7.1.006.0004.004.ogg — decoded only 13376 samples
- `audio` #2591 sound.7.1.006.0004.005.ogg — decoded only 12519 samples
- `audio` #2592 sound.7.1.006.0004.006.ogg — decoded only 11392 samples
- `audio` #2595 sound.7.1.006.0005.003.ogg — decoded only 18273 samples
- `audio` #2599 sound.7.1.006.0006.001.ogg — decoded only 16754 samples
- `audio` #2600 sound.7.1.006.0006.002.ogg — decoded only 15493 samples
- `audio` #2601 sound.7.1.006.0006.003.ogg — decoded only 15691 samples
- `audio` #2602 sound.7.1.006.0006.004.ogg — decoded only 14653 samples
- `audio` #2603 sound.7.1.006.0006.005.ogg — decoded only 15971 samples
- `audio` #2604 sound.7.1.006.0006.006.ogg — decoded only 15843 samples
- `audio` #2605 sound.7.1.006.0007.001.ogg — decoded only 13753 samples
- `audio` #2606 sound.7.1.006.0007.002.ogg — decoded only 13621 samples
- `audio` #2607 sound.7.1.006.0007.003.ogg — decoded only 13625 samples
- `audio` #2608 sound.7.1.006.0007.004.ogg — decoded only 13753 samples
- `audio` #2609 sound.7.1.006.0007.005.ogg — decoded only 13753 samples
- `audio` #2610 sound.7.1.006.0007.006.ogg — decoded only 13165 samples
- `audio` #2611 sound.7.1.006.0008.001.ogg — decoded only 19329 samples
- `audio` #2612 sound.7.1.006.0008.002.ogg — decoded only 18503 samples
- `audio` #2613 sound.7.1.006.0008.003.ogg — decoded only 17677 samples

## Random sample profiles

### #714 Mario Minor 2 — Powerglove (Continue?)

- genres: ['metal', 'vgm'] · styles: ['power metal', 'medley', 'instrumental metal', 'shred']
- moods: ['playful', 'triumphant', 'energetic', 'nostalgic'] · themes: ['super mario', 'nintendo', 'video games']
- energy 8/10 · bpm 112.3 · year 2018 · vocals instrumental · lang None
- A near-seven-minute Super Mario medley, sequel to Powerglove's earlier 'Mario Minor,' stitching Nintendo themes into galloping instrumental metal. Tempo sits around 112 BPM with constant riff and section changes and plenty of lead-guitar showboating. Nostalgia bait executed with real chops.

### #828 Transylvanian Transmissions, Part 1 — Rob Zombie (The Sinister Urge)

- genres: ['metal', 'electronic'] · styles: ['dark ambient', 'spoken word', 'industrial']
- moods: ['eerie', 'unsettling', 'cinematic', 'dark'] · themes: ['horror', 'vampires', 'blood']
- energy 2/10 · bpm 117.5 · year 2001 · vocals spoken · lang en
- A 69-second interlude of murky loops and horror-film narration about blood and transfusion, sitting mid-album on The Sinister Urge. Quiet and low-frequency, essentially a mood bridge between songs. Not found in MusicBrainz but clearly the album's interstitial piece.

### #1824 hoshi no koe ga kikoeru — Nobuo Uematsu (Final Fantasy VII Original Sound Track, Disc 3 [SSCX-10004])

- genres: ['vgm', 'soundtrack'] · styles: ['jrpg score', 'ambient synth', 'orchestral synth']
- moods: ['mystical', 'otherworldly', 'melancholic'] · themes: ['final fantasy vii', 'lifestream', 'cosmos']
- energy 4/10 · bpm 172.3 · year 1997 · vocals instrumental · lang None
- Uematsu cue from FFVII disc 3 ('You Can Hear the Cry of the Planet'), built on airy sustained pads and shimmering figures despite a fast detected pulse. Quiet and reverent rather than driving. Sits in the reflective, story-beat half of the soundtrack.

### #732 Mario Minor — Powerglove (Metal Kombat for the Mortal Man)

- genres: ['metal', 'vgm'] · styles: ['power metal', 'video game metal', 'instrumental shred']
- moods: ['playful', 'nostalgic', 'energetic', 'triumphant'] · themes: ['super mario', 'video games', 'nostalgia']
- energy 8/10 · bpm 112.3 · year 2007 · vocals instrumental · lang None
- Powerglove's signature Super Mario medley in minor-key metal dress, threading overworld and underground themes through galloping riffs and twin-guitar leads. Instrumental, loud and grinning. From Metal Kombat for the Mortal Man (2007).

### #1045 The Crossroads (Cid's Theme) — Jovette Rivera (Final Fantasy VII: Voices of the Lifestream)

- genres: ['vgm', 'funk', 'hip hop'] · styles: ['ocremix', 'funk rock', 'rap-sung vocals', 'groove']
- moods: ['confident', 'funky', 'determined', 'gritty'] · themes: ['final fantasy vii', 'identity', 'rivalry', 'choices']
- energy 7/10 · bpm 117.5 · year 2007 · vocals male · lang en
- Jovette Rivera's vocal funk take on Cid's Theme, with rapped verses and a sung chorus about facing a double and choosing between immortality and love. Roughly 118 BPM with a bright, punchy band mix and steady groove. One of the album's standout vocal tracks.

### #1545 Fragments of Memories (Arranged Version) (FFVIII) — VA (Final Fantasy S Generation: Official Best Collection)

- genres: ['vgm'] · styles: ['arrangement', 'orchestral', 'ambient']
- moods: ['melancholic', 'dreamlike', 'tender', 'nostalgic'] · themes: ['final fantasy', 'memory', 'love']
- energy 4/10 · bpm 117.5 · year 2001 · vocals instrumental · lang None
- An arranged take on 'Fragments of Memories' from Final Fantasy VIII, the wistful ocean/memory cue. Moderate tempo and restrained dynamics with a fairly bright but soft texture, floating rather than driving. From the 2001 Final Fantasy S Generation collection; quiet late-night listening.

### #785 Bicycle Race — Queen (Greatest Hits)

- genres: ['classic rock'] · styles: ['pop rock', 'art rock', 'music hall']
- moods: ['playful', 'quirky', 'upbeat', 'cheeky'] · themes: ['bicycles', 'nonconformity', 'humor']
- energy 8/10 · bpm 161.5 · year 1981 · vocals male · lang en
- Fast, bright, and deliberately silly, with rapid-fire key changes, bicycle bells and stacked vocal harmonies. Highest tempo and brightest spectrum of this Greatest Hits batch. Novelty-leaning Queen that still rocks.

### #1888 Cosmo Canyon (FINAL FANTASY VII) — Hiroyuki Nakayama, Nobuo Uematsu (PIANO OPERA FINAL FANTASY VII／VIII／XI)

- genres: ['vgm', 'classical'] · styles: ['solo piano', 'arrangement']
- moods: ['warm', 'contemplative', 'earthy', 'nostalgic'] · themes: ['final fantasy', 'home', 'nature']
- energy 4/10 · bpm 117.5 · year 2014 · vocals instrumental · lang None
- Nakayama arranges Cosmo Canyon's guitar-and-flute theme for piano, keeping its loping rhythm and open, folk-tinged harmonies. Moderate tempo, mid-level dynamics, meditative throughout. From the 2014 PIANO OPERA album.

### #1954 Ninja Gaiden - Mine Shaft — The Advantage (The Advantage)

- genres: ['rock', 'vgm'] · styles: ['instrumental rock', 'math rock', 'nintendocore', 'game cover']
- moods: ['driving', 'dark', 'energetic', 'nostalgic'] · themes: ['video games', 'ninja gaiden']
- energy 7/10 · bpm 143.6 · year 2004 · vocals instrumental · lang None
- Ninja Gaiden's mine shaft stage music rendered by guitars, bass and drums at a brisk 143bpm. Darker-toned than the Mario tracks, with a slightly muffled midrange and relentless eighth-note motion. From The Advantage's 2004 debut.

### #1823 jukai no shinden — Nobuo Uematsu (Final Fantasy VII Original Sound Track, Disc 3 [SSCX-10004])

- genres: ['vgm', 'soundtrack'] · styles: ['orchestral synth', 'jrpg score', 'ambient']
- moods: ['mysterious', 'solemn', 'dark'] · themes: ['final fantasy vii', 'temple', 'ancients']
- energy 4/10 · bpm 112.3 · year 1997 · vocals instrumental · lang None
- PlayStation-era synth score from Final Fantasy VII disc 3, the Temple of the Ancients music. Mid-tempo, moderately dense sequenced strings and percussion with a heavy sense of dread and mystery. Background listening for dungeon-crawling nostalgia.

### #2588 sound.7.1.006.0004.002 — ? (no album)

- genres: ['unknown'] · styles: ['sound effect', 'game asset']
- moods: ['neutral', 'utilitarian'] · themes: []
- energy 3/10 · bpm None · year None · vocals instrumental · lang None
- Very short untagged clip from the 'wurm' folder's sequential sound asset dump. Nothing identifies the source game or creator, and ASR found no voice. Profiled honestly as an unknown sound effect.

### #2091 The Last March (The Imperial Army) — Dr. Manhattan (Final Fantasy II: Rebellion)

- genres: ['vgm', 'orchestral', 'electronic'] · styles: ['ocremix', 'game remix', 'cinematic', 'march']
- moods: ['ominous', 'militaristic', 'dark', 'tense'] · themes: ['final fantasy', 'war', 'empire']
- energy 6/10 · bpm 123.0 · year 2015 · vocals instrumental · lang None
- Dr. Manhattan's arrangement of 'The Imperial Army' for OCRemix's Final Fantasy II: Rebellion. A 123 BPM march with a restrained dynamic range and looming, villainous tone fitting the Emperor's forces. Instrumental.

### #408 On The Turning Away — Pink Floyd (A Momentary Lapse Of Reason)

- genres: ['classic rock', 'rock'] · styles: ['progressive rock', 'art rock', 'power ballad']
- moods: ['mournful', 'earnest', 'building', 'hopeful'] · themes: ['poverty', 'compassion', 'social conscience']
- energy 5/10 · bpm 99.4 · year 1987 · vocals male · lang en
- Begins hushed with clean guitar and organ, then swells into a full-band climax with one of Gilmour's most famous extended solos. The lyric is a plea against ignoring the poor and downtrodden. A slow-build highlight of A Momentary Lapse of Reason.

### #542 Breathe in the Air — Pink Floyd (The Dark Side of the Moon)

- genres: ['classic rock', 'progressive rock'] · styles: ['psychedelic rock', 'space rock', 'blues rock']
- moods: ['dreamy', 'melancholic', 'hypnotic', 'spacious'] · themes: ['mortality', 'routine', 'life']
- energy 4/10 · bpm 129.2 · year 1973 · vocals male · lang en
- Slow-drifting slide guitar, lush Rhodes chords and hushed harmony vocals over a lazy shuffle — the first proper song on The Dark Side of the Moon. Warm, low-midrange mix with soft dynamics matches the mellow measured levels. Good for headphone drifting and album-in-full listening.

### #2248 The Point of No Return — Immortal Technique (Revolutionary, Vol. 2)

- genres: ['hip hop'] · styles: ['political hip hop', 'underground hip hop', 'boom bap']
- moods: ['militant', 'defiant', 'dark', 'intense'] · themes: ['revolution', 'colonialism', 'prison', 'race']
- energy 8/10 · bpm 89.1 · year 2003 · vocals male · lang en
- A slow, heavy-hitting declaration of no-turning-back militancy, stacking references to genocide, colonization and Malcolm X over loud, bass-forward production. The delivery is measured but seething. Opening statement-of-purpose material from Revolutionary Vol. 2.
