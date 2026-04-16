# PlateBlur Evaluation Report

- Model: `/Users/applemima111/Desktop/car/models/plateblur_training/pp4av_focus_de_ch/weights/best.mlpackage`
- Dataset: `/Users/applemima111/Desktop/car/eval_data/keremberke/test`
- Confidence threshold: `0.2`
- IoU threshold: `0.45`
- Inference mode: `hybrid`
- Tile size: `640`
- Tile overlap: `0.4`
- Tile confidence threshold: `0.2`

## COCO Detection Metrics

- Images evaluated: `882`
- `AP@[0.50:0.95]`: `0.1270`
- `AP@0.50`: `0.2413`
- `AP@0.75`: `0.1041`
- `AR@100`: `0.1563`
- `Precision@IoU0.50`: `0.8255`
- `Recall@IoU0.50`: `0.2517`
- `F1@IoU0.50`: `0.3857`
- Image recall@IoU0.50: `0.2528`
- Average latency per image: `15.41 ms`
- P95 latency per image: `25.01 ms`
- Images with no predictions: `635`

## Scene-Level Public Validation Sets

These subsets keep full driving-scene context, so they are better indicators of real-world anonymization performance than cropped-plate smoke tests.

### PP4AV Switzerland Holdout

- Images evaluated: `75`
- `AP@[0.50:0.95]`: `0.1656`
- `AP@0.50`: `0.6081`
- `AP@0.75`: `0.0204`
- `AR@100`: `0.2908`
- `Precision@IoU0.50`: `0.5688`
- `Recall@IoU0.50`: `0.8158`
- `F1@IoU0.50`: `0.6703`
- Image recall@IoU0.50: `0.8267`
- Average latency per image: `38.22 ms`
- P95 latency per image: `43.67 ms`
- Images with no predictions: `3`

## Country Crop Smoke Tests

These small public datasets are cropped plate photos, so they are useful as region-support smoke tests, not as full-scene detection benchmarks.

### Germany

- Images: `10`
- Detector hit rate: `0.7000`
- Average top score: `0.4168`

### Netherlands

- Images: `10`
- Detector hit rate: `0.5000`
- Average top score: `0.1597`
