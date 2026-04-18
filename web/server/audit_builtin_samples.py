from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

from detector_service import detect_from_bytes

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DIR = REPO_ROOT / "PlateBlur" / "SamplePhotos"
OUTPUT_DIR = REPO_ROOT / "reports" / "dedicated-detector"

SAMPLE_IDS = {
    "de-crop-01.jpg": "sample-de-crop-01",
    "de-crop-02.jpg": "sample-de-crop-02",
    "nl-crop-01.jpg": "sample-nl-crop-01",
    "nl-crop-02.jpg": "sample-nl-crop-02",
    "street-scene-01.jpg": "sample-street-scene-01",
    "street-scene-02.jpg": "sample-street-scene-02",
    "street-scene-03.jpg": "sample-street-scene-03",
    "swiss-scene-01.png": "sample-swiss-scene-01",
    "swiss-scene-02.png": "sample-swiss-scene-02",
    "swiss-scene-03.png": "sample-swiss-scene-03",
    "swiss-scene-04.png": "sample-swiss-scene-04",
}


def render_boxes(image: Image.Image, boxes: list[dict[str, float | str]]) -> Image.Image:
    canvas = image.copy()
    draw = ImageDraw.Draw(canvas)
    for box in boxes:
        x1 = float(box["x"]) * image.width
        y1 = float(box["y"]) * image.height
        x2 = x1 + (float(box["w"]) * image.width)
        y2 = y1 + (float(box["h"]) * image.height)
        color = "#24E5FF" if str(box.get("kind")) == "plate" else "#FF9800"
        draw.rectangle((x1, y1, x2, y2), outline=color, width=4)
    return canvas


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = []

    for sample_path in sorted(SAMPLE_DIR.iterdir()):
        payload = sample_path.read_bytes()
        sample_id = SAMPLE_IDS.get(sample_path.name, "")
        detection = detect_from_bytes(payload, sample_id=sample_id, include_text=True)
        image = Image.open(sample_path).convert("RGB")
        annotated = render_boxes(image, detection["boxes"])
        annotated.save(OUTPUT_DIR / sample_path.name)
        summary.append(
            {
                "name": sample_path.name,
                "sampleId": sample_id,
                "boxCount": detection["box_count"],
                "boxes": detection["boxes"],
            }
        )

    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
