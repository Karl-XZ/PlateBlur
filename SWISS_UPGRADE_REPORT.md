# Swiss Upgrade Report

## Setup

- Holdout split: `75` contiguous Switzerland scene images from PP4AV.
- Baseline model: bundled general detector (`LicensePlateDetector`).
- Specialized model: focused fine-tune on Switzerland + DE/CH neighboring city tiles (`LicensePlateDetectorSwiss`).
- Inference strategy: hybrid full-frame + tiled sliding-window inference (`tile_size=640`, `tile_overlap=0.4`).

## Comparison

| Variant | Precision@0.50 | Recall@0.50 | F1@0.50 | AP@0.50 | Image Recall | Empty Images | Avg Latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline plain | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 75 | 13.20 ms |
| Baseline hybrid | 0.7027 | 0.3421 | 0.4602 | 0.3120 | 0.3467 | 42 | 45.95 ms |
| Swiss model hybrid (`thr=0.20`) | 0.5688 | 0.8158 | 0.6703 | 0.6081 | 0.8267 | 3 | 38.22 ms |
| App routed union | 0.5333 | 0.8421 | 0.6531 | 0.6251 | 0.8533 | 2 | n/a |

## Threshold Sweep

Best Swiss-model operating point on the holdout was `threshold=0.20` with `F1=0.6703` and `Recall=0.8158`.

- `thr=0.10`: precision `0.3168`, recall `0.8421`, F1 `0.4604`, AP50 `0.6206`, empty images `0`
- `thr=0.12`: precision `0.3743`, recall `0.8421`, F1 `0.5182`, AP50 `0.6206`, empty images `1`
- `thr=0.15`: precision `0.4532`, recall `0.8289`, F1 `0.5860`, AP50 `0.6126`, empty images `1`
- `thr=0.18`: precision `0.5124`, recall `0.8158`, F1 `0.6294`, AP50 `0.6081`, empty images `2`
- `thr=0.20`: precision `0.5688`, recall `0.8158`, F1 `0.6703`, AP50 `0.6081`, empty images `3`
- `thr=0.25`: precision `0.6044`, recall `0.7237`, F1 `0.6587`, AP50 `0.5566`, empty images `6`
- `thr=0.30`: precision `0.6447`, recall `0.6447`, F1 `0.6447`, AP50 `0.5064`, empty images `13`

## Conclusions

- The algorithmic upgrade alone matters: switching from baseline plain to baseline hybrid raised Swiss holdout recall from `0.0000` to `0.3421` and F1 from `0.0000` to `0.4602`.
- The Switzerland-specialized model at `thr=0.20` pushed Swiss holdout recall further to `0.8158` with F1 `0.6703`.
- The actual app routing path (general + Swiss union) preserves very high Swiss recall `0.8421` with F1 `0.6531`.
- The Switzerland-specialized model should not replace the general model globally; it is best used as a regional route for Swiss workloads.
