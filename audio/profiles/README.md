# `audio/profiles/`

Learned noise-PSD profiles for `pipeline.spectral_subtract`. One `.npz` per
noise environment.

## Files

- `machine.npz` — **prototyping** profile learned from
  `/home/user/May 28 at 9-22 PM.m4a` (60 s phone recording of Adam's machine).
  Validated to give 5-8 dB noise reduction on holdout with <0.6 dB loss on a
  speech-level signal. Suitable for development and dry-running the pipeline;
  **not suitable for production** — phone HE-AAC codec + phone-mic capsule
  doesn't match the DJI TX2 capture path used at inference time.

  When Adam is back at the machine with the DJI, re-record `noise.wav` with
  the DJI TX2 collar mic itself and regenerate the profile:

  ```bash
  audio/venv/bin/python audio/tools/learn_noise_profile.py \
    /path/to/dji_noise.wav --output audio/profiles/machine.npz
  ```

## Format

See `audio/README.md` § Profiles for the schema. Loaded via
`pipeline.spectral_subtract.load_profile(path)`.

## Versioning

Profiles are derived data — small, deterministic given the input recording,
and easily regenerated. They're checked into git so reviewers can reproduce
experiments without needing the source recording (which may contain ambient
or private audio not safe to commit). When you regenerate a profile, commit
it alongside the change so the validation numbers in commit messages are
reproducible.
