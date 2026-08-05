# Phase A enrichment report — 2026-08-05

Tracks indexed: **2675**
Dupe clusters: **585** covering **1423** tracks
Lyrics cache rows: 1556 (480 with lyrics)
Qdrant `g2cc_music` points: 2675
Transcode cache: 2672 files, 7.87 GB

## Pass coverage

| pass | ok | failed | pending |
|---|---|---|---|
| tags | 2675 | 0 | 0 |
| musicbrainz | 2675 | 0 | 0 |
| lyrics | 2675 | 0 | 0 |
| audio | 2614 | 61 | 0 |
| profile | 2675 | 0 | 0 |
| embed | 2675 | 0 | 0 |
| dedupe | 2675 | 0 | 0 |
| pretranscode | 2672 | 3 | 0 |

## Field fill rates

- **genres**: 2675/2675 (100%)
- **styles**: 2675/2675 (100%)
- **moods**: 2675/2675 (100%)
- **energy**: 2675/2675 (100%)
- **bpm**: 2614/2675 (97%)
- **year**: 2320/2675 (86%)
- **vocals**: 2675/2675 (100%)
- **language**: 984/2675 (36%)
- **themes**: 2419/2675 (90%)
- **description**: 2675/2675 (100%)

## Top genres

vgm (1421), classic rock (427), electronic (427), hip hop (370), metal (339), rock (319), classical (313), unknown (225), soundtrack (180), progressive rock (136), folk (88), jazz (74), industrial (64), psychedelic rock (64), ambient (39), pop (39), spoken word (24), new age (21), funk (20), latin (12)

## Top moods

dark (719), driving (374), melancholic (318), tense (312), playful (307), aggressive (304), triumphant (230), dramatic (225), urgent (200), nostalgic (198), reflective (192), epic (185), ominous (182), brooding (174), warm (168), wistful (156), gritty (154), energetic (142), neutral (130), bittersweet (127)

## Top styles

ocremix (346), underground hip hop (252), boom bap (248), solo piano (243), arrangement (190), game arrange (175), ambient (170), game remix (161), political hip hop (148), art rock (147), orchestral (138), chiptune (128), industrial metal (119), cinematic (110), hard rock (104), instrumental rock (100), downtempo (90), prog rock (90), sound effect (89), symphonic (89)

## Failures (43 shown, 40/pass cap)

- `audio` #641 01 - Astronomy Domine.flac — decoded only 0 samples
- `audio` #675 04 - A Saucerful Of Secrets.flac — ffmpeg decode rc=183: [af#0:0 @ 0x5587e724bc80] Cannot determine format of input 0:0 after EOF
[af#0:0 @ 0x5587e724bc80] Task finished with error code: -1094995529 (Invalid data found when processing input)
[af#0:0 @ 0x5587e724bc80] Terminating thread with return code -1094995529 (Invalid data found when processing input
- `audio` #764 02 - Soul Brother.flac — ffmpeg decode rc=183: [af#0:0 @ 0x558ad7c26c80] Cannot determine format of input 0:0 after EOF
[af#0:0 @ 0x558ad7c26c80] Task finished with error code: -1094995529 (Invalid data found when processing input)
[af#0:0 @ 0x558ad7c26c80] Terminating thread with return code -1094995529 (Invalid data found when processing input
- `audio` #796 01 Queen - Headlong.flac — decoded only 0 samples
- `audio` #2370 02 - Soul Brother.flac — ffmpeg decode rc=183: [af#0:0 @ 0x55c9a70ecc80] Cannot determine format of input 0:0 after EOF
[af#0:0 @ 0x55c9a70ecc80] Task finished with error code: -1094995529 (Invalid data found when processing input)
[af#0:0 @ 0x55c9a70ecc80] Terminating thread with return code -1094995529 (Invalid data found when processing input
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
- `pretranscode` #675 04 - A Saucerful Of Secrets.flac — ffmpeg rc=183: [af#0:0 @ 0x562717e2ae80] Cannot determine format of input 0:0 after EOF
[af#0:0 @ 0x562717e2ae80] Task finished with error code: -1094995529 (Invalid data found when processing input)
[af#0:0 @ 0x562717e2ae80] Terminating thread with return code -1094995529 (Invalid data found when processing input
- `pretranscode` #764 02 - Soul Brother.flac — ffmpeg rc=183: [af#0:0 @ 0x55f307b1be80] Cannot determine format of input 0:0 after EOF
[af#0:0 @ 0x55f307b1be80] Task finished with error code: -1094995529 (Invalid data found when processing input)
[af#0:0 @ 0x55f307b1be80] Terminating thread with return code -1094995529 (Invalid data found when processing input
- `pretranscode` #2370 02 - Soul Brother.flac — ffmpeg rc=183: [af#0:0 @ 0x557b94865e80] Cannot determine format of input 0:0 after EOF
[af#0:0 @ 0x557b94865e80] Task finished with error code: -1094995529 (Invalid data found when processing input)
[af#0:0 @ 0x557b94865e80] Terminating thread with return code -1094995529 (Invalid data found when processing input

## Random sample profiles

### #2188 Internally Bleeding — Immortal Technique (Revolutionary Vol. 2)

- genres: ['hip hop'] · styles: ['underground hip hop', 'boom bap', 'political hip hop', 'horrorcore']
- moods: ['bleak', 'angry', 'dark', 'intense'] · themes: ['loss', 'abortion', 'religion', 'genocide', 'pain']
- energy 6/10 · bpm 73.8 · year 2003 · vocals male · lang en
- Slow, heavy boom bap near 74 BPM with a mournful loop backing some of Immortal Technique's most personally brutal writing about loss, faith, and rage. Sparse arrangement leaves the vocal exposed and confrontational. From Revolutionary Vol. 2 (2003).

### #402 Signs Of Life — Pink Floyd (A Momentary Lapse Of Reason)

- genres: ['classic rock', 'progressive rock'] · styles: ['prog rock', 'ambient', 'instrumental intro', 'art rock']
- moods: ['atmospheric', 'dreamy', 'mysterious', 'calm'] · themes: ['awakening', 'memory']
- energy 3/10 · bpm 117.5 · year 1987 · vocals instrumental · lang en
- The ambient opening piece of A Momentary Lapse of Reason: lapping water, birds, keyboard washes and a spoken murmur before Gilmour's guitar lifts in. Almost entirely instrumental atmosphere with only faint spoken fragments. Sets the mood for the album rather than standing alone.

### #522 Eclipse — Pink Floyd (Pulse [Disc 2])

- genres: ['classic rock', 'rock'] · styles: ['progressive rock', 'gospel rock', 'live', 'anthemic']
- moods: ['triumphant', 'cathartic', 'uplifting', 'dramatic'] · themes: ['mortality', 'existence', 'madness']
- energy 7/10 · bpm 136.0 · year 1995 · vocals mixed · lang en
- The rising, gospel-backed finale of Dark Side played live: massed backing vocals, organ swell and a hard-stop ending on the heartbeat. Short, loud and cumulative, arriving straight out of 'Brain Damage'. Closes the album sequence on a big emotional lift.

### #1382 Fighting — Seiji Honda (Piano Collections Final Fantasy VII)

- genres: ['vgm', 'classical'] · styles: ['solo piano', 'game arrange', 'virtuoso piano']
- moods: ['driving', 'tense', 'urgent', 'dramatic'] · themes: ['final fantasy vii', 'battle']
- energy 7/10 · bpm 161.5 · year 2003 · vocals instrumental · lang None
- The FFVII battle theme reworked as a fast, hammering piano showpiece with dense onsets and loud dynamics. From the official Piano Collections arranged by Shiro Hamaguchi. Adrenaline piece for the album's midpoint.

### #1306 Coin Of Fate — TPR (World Of Ruin: Melancholy Music From Final Fantasy VI)

- genres: ['vgm', 'ambient'] · styles: ['ambient piano', 'game arrange', 'drone']
- moods: ['melancholic', 'fateful', 'dark', 'calm'] · themes: ['final fantasy vi', 'fate']
- energy 2/10 · bpm 136.0 · year 2016 · vocals instrumental · lang None
- The quietest cut here — very low RMS and sparse onsets make this a near-drone piano meditation on FFVI's 'Coin of Fate'. Long decays, minimal movement, heavy air. Ambient background music.

### #338 Death March — Immortal Technique (The 3rd World)

- genres: ['hip hop'] · styles: ['underground hip hop', 'political hip hop', 'hardcore hip hop', 'boom bap']
- moods: ['militant', 'menacing', 'aggressive', 'dark'] · themes: ['imperialism', 'war', 'latin america', 'propaganda']
- energy 8/10 · bpm 89.1 · year 2008 · vocals male · lang en
- Opening salvo of The 3rd World, produced in the DJ Green Lantern mixtape style, with Technique framing the record as guerrilla warfare against the industry and US foreign policy in Latin America. Loud, thick drums at ~89 BPM with a bright, compressed mix. Sets an invasion-announcement tone for the album.

### #160 Hydrophone Breakdown (Secret of the Deep Sea) — JJT (Final Fantasy VII: Voices of the Lifestream)

- genres: ['vgm', 'electronic'] · styles: ['ocremix', 'game remix', 'drum and bass', 'liquid']
- moods: ['mysterious', 'aquatic', 'driving', 'atmospheric'] · themes: ['final fantasy vii', 'deep sea', 'ocean']
- energy 7/10 · bpm 161.5 · year 2007 · vocals instrumental · lang None
- JJT's remix of FFVII's 'Secret of the Deep Sea' from OCRemix's Voices of the Lifestream. Fast ~160 BPM breaks under dark, filtered, underwater-sounding pads and subby low end. Deep and propulsive rather than harsh.

### #921 The Girl Who Loved The Monsters — Rob Zombie (Venomous Rat Regeneration Vendor)

- genres: ['metal', 'rock'] · styles: ['industrial metal', 'alternative metal', 'groove metal']
- moods: ['dark', 'melancholic', 'brooding', 'defiant'] · themes: ['monsters', 'self-harm', 'outsiders']
- energy 6/10 · bpm 117.5 · year 2013 · vocals male · lang en
- A comparatively moody mid-tempo track at 118 BPM with a darker, more melodic chorus about an outcast girl who loves monsters. Slightly restrained mix (mean RMS -12.5 dB) with sustained guitar and Zombie's clean rasp. One of the more emotionally weighted songs on the album.

### #534 More Blues — Pink Floyd (Soundtrack From The Film 'More')

- genres: ['blues', 'classic rock'] · styles: ['blues rock', 'instrumental', 'slow blues']
- moods: ['smoky', 'laid-back', 'mournful', 'late-night'] · themes: ['film score']
- energy 4/10 · bpm 143.6 · year 1969 · vocals instrumental · lang None
- A quiet twelve-bar instrumental blues from the 'More' soundtrack, with Gilmour's clean lead over brushed drums and organ. Very low measured loudness — a mood cue more than a showcase. Bar-scene filler music that still sounds good on its own.

### #2584 sound.7.1.006.0003.004 — ? (no album)

- genres: ['unknown'] · styles: ['sound effect', 'game asset']
- moods: ['neutral', 'utilitarian'] · themes: []
- energy 2/10 · bpm None · year None · vocals instrumental · lang None
- Last of this batch of one-second 'wurm' sound-bank assets, sequentially numbered like the rest. No detected speech, no tags, and no trustworthy identification available. Catalogued honestly as an unknown-origin game sound effect.

### #1859 Aerith Theme (FF VII) — Nobuo Uematsu (MORE FRIENDS Music From FINAL FANTASY)

- genres: ['vgm', 'classical'] · styles: ['orchestral', 'ballad', 'live']
- moods: ['melancholic', 'tender', 'bittersweet', 'reflective'] · themes: ['final fantasy', 'loss']
- energy 3/10 · bpm 143.6 · year 2005 · vocals instrumental · lang None
- Aerith's Theme performed by orchestra at the More Friends Final Fantasy concert. Soft dynamics (mean RMS around -20 dB) and dark, low spectral content — strings and woodwinds carrying one of Uematsu's saddest melodies. For quiet, mournful listening.

### #326 Industrial Revolution — Immortal Technique (Revolutionary, Vol. 2)

- genres: ['hip hop'] · styles: ['underground hip hop', 'east coast hip hop', 'boom bap', 'political hip hop']
- moods: ['aggressive', 'confrontational', 'dark', 'confident'] · themes: ['music industry', 'battle rap', 'authenticity']
- energy 7/10 · bpm 83.4 · year 2003 · vocals male · lang en
- Grimy boom-bap at ~83 BPM with dusty loops and hard drums under Immortal Technique's dense, snarling battle verses attacking the bling era and record execs. From Revolutionary Vol. 2, a cornerstone of early-2000s Harlem underground rap. Good for headphone listening when you want lyrical aggression over polish.

### #2233 Positive Balance — Immortal Technique (Revolutionary, Vol. 1)

- genres: ['hip hop'] · styles: ['underground hip hop', 'conscious hip hop', 'boom bap']
- moods: ['confident', 'uplifting', 'determined', 'gritty'] · themes: ['positivity', 'self-improvement', 'hip hop culture', 'materialism']
- energy 7/10 · bpm 86.1 · year 2001 · vocals male · lang en
- Loud, punchy 86 BPM boom bap (mean RMS -13.4 dB) with Big Zoo trading verses about choosing positivity over negativity and industry gimmicks. From Technique's self-released debut Revolutionary Vol. 1. Wordplay-dense and motivational without going soft.

### #686 So Sexy Robotnik — Powerglove (Metal Kombat for the Mortal Man)

- genres: ['metal', 'vgm'] · styles: ['power metal', 'speed metal', 'video game metal']
- moods: ['playful', 'swaggering', 'energetic', 'fun'] · themes: ['sonic the hedgehog', 'video games', 'villains']
- energy 8/10 · bpm 92.3 · year 2007 · vocals instrumental · lang None
- Powerglove's cheeky metal spin on Robotnik's theme from Sonic the Hedgehog 2, opening Metal Kombat for the Mortal Man. Mid-tempo strut with layered guitar harmonies and plenty of shred fills. Instrumental and tongue-in-cheek.

### #109 Heroes of Dawn [Chaos Temple (FF1), Reunion, The Rebel Army, Deep Under the Water (FF3), Dead Music (FF1)] — PacificPoem (Final Fantasy II: Rebellion)

- genres: ['vgm', 'rock'] · styles: ['ocremix', 'orchestral rock', 'medley', 'cinematic']
- moods: ['epic', 'dramatic', 'adventurous', 'building'] · themes: ['final fantasy', 'rebellion', 'fantasy']
- energy 6/10 · bpm 161.5 · year 2015 · vocals instrumental · lang None
- A long, multi-theme OverClocked ReMix medley opening disc two of Final Fantasy II: Rebellion, weaving Chaos Temple, The Rebel Army and other Uematsu themes into one arc. Fairly quiet, dynamic-range-heavy mix with a dark low-mid focus that builds toward brighter heroic statements. Good for long-form background listening or a fantasy questing playlist.
