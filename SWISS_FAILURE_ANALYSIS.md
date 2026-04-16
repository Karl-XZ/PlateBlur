# Switzerland Failure Analysis

## Main Finding

The detector is collapsing on PP4AV Switzerland primarily because the plates are dramatically smaller in-frame than the plates in the reference benchmark. The dominant failure mode is no detection at all, not slightly misaligned boxes.

## Domain Shift vs Reference Benchmark

- Reference median plate area ratio: `0.023452`
- Switzerland median plate area ratio: `0.000296`
- Area shrink factor at the median: `79.3x`
- Reference median plate size at 640 input: `123.4 x 76.0` px
- Switzerland median plate size at 640 input: `14.0 x 8.4` px
- Switzerland plates below 16 px width at model input: `63.9%`
- Switzerland plates below 8 px height at model input: `44.3%`
- Reference plates below 16 px width at model input: `0.6%`
- Reference plates below 8 px height at model input: `0.3%`

## Image-Level Failure Pattern

- Images with Swiss plates: `363`
- Images with any correct hit: `13`
- Images with all plates correctly hit: `10`
- Full-miss images: `350`
- Images with no predictions at all: `328`
- Images with predictions but no correct hit: `22`

## Threshold Sweep

Lowering the confidence threshold helps a bit, but not nearly enough. This means the main problem is detector visibility/scale, not just filtering.

- Threshold `0.01`: predictions `709`, precision `0.1199`, recall `0.1893`, F1 `0.1468`
- Threshold `0.03`: predictions `265`, precision `0.1887`, recall `0.1114`, F1 `0.1401`
- Threshold `0.05`: predictions `179`, precision `0.1899`, recall `0.0757`, F1 `0.1083`
- Threshold `0.10`: predictions `106`, precision `0.2736`, recall `0.0646`, F1 `0.1045`
- Threshold `0.25`: predictions `36`, precision `0.3611`, recall `0.0290`, F1 `0.0536`

## Size-Bin Recall at App Threshold

- smallest_third: recall `0.0000`, median size `19.7 x 6.6` px
- middle_third: recall `0.0000`, median size `28.0 x 9.3` px
- largest_third: recall `0.0867`, median size `38.4 x 13.3` px

## What The Detector Actually Does

- Matched plates median size: `50.8 x 18.0` px
- Missed plates median size: `27.7 x 9.3` px
- Matched plates median center Y: `0.818`
- Missed plates median center Y: `0.726`
- Ground-truth plates with zero overlap to any kept prediction: `435`
- Ground-truth plates with partial overlap 0.3-0.5: `1`

## Interpretation

- The detector is not mostly drawing boxes in the wrong place. It is usually drawing no useful box at all.
- Lower frame position is not the main issue. The successful plates are actually slightly lower in the frame than the missed plates.
- The dominant issue is scale: the Swiss plates are mostly tiny at the model's 640 input resolution, and the model appears to have been trained on much larger plate presentations.
- Because recall remains poor even at threshold 0.01, post-processing tweaks alone will not fix this. The model needs more small-object supervision or a higher-resolution detection path.

## Largest Missed Examples

- `frame_000582.png`: `71.8 x 31.4` px, best IoU `0.000`, best score `0.000`
- `frame_000581.png`: `69.6 x 29.0` px, best IoU `0.000`, best score `0.000`
- `frame_000580.png`: `69.7 x 26.3` px, best IoU `0.000`, best score `0.000`
- `frame_000579.png`: `68.2 x 26.2` px, best IoU `0.000`, best score `0.000`
- `frame_000578.png`: `67.7 x 24.3` px, best IoU `0.000`, best score `0.000`
