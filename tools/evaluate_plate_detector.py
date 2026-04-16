#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Sequence

import coremltools as ct
import numpy as np
from PIL import Image
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval


@dataclass
class Prediction:
    bbox_xywh: List[float]
    score: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate the bundled Core ML license plate detector.")
    parser.add_argument(
        "--model",
        default="/Users/applemima111/Desktop/car/models/koushim/best.mlpackage",
        help="Path to the Core ML package to evaluate.",
    )
    parser.add_argument(
        "--dataset-dir",
        default="/Users/applemima111/Desktop/car/eval_data/keremberke/test",
        help="Directory containing images and _annotations.coco.json.",
    )
    parser.add_argument(
        "--confidence-threshold",
        type=float,
        default=0.25,
        help="Detector confidence threshold.",
    )
    parser.add_argument(
        "--iou-threshold",
        type=float,
        default=0.45,
        help="Detector NMS IoU threshold.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional limit for debugging. 0 means full dataset.",
    )
    parser.add_argument(
        "--inference-mode",
        choices=["plain", "tiled", "hybrid"],
        default="plain",
        help="Prediction mode: plain whole-image inference, tiled sliding-window inference, or hybrid full-frame + tiled fusion.",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=640,
        help="Sliding-window tile size used for tiled or hybrid inference.",
    )
    parser.add_argument(
        "--tile-overlap",
        type=float,
        default=0.4,
        help="Sliding-window overlap used for tiled or hybrid inference.",
    )
    parser.add_argument(
        "--tile-confidence-threshold",
        type=float,
        default=-1,
        help="Optional confidence threshold override for tile predictions. Defaults to --confidence-threshold.",
    )
    parser.add_argument(
        "--report-json",
        default="/Users/applemima111/Desktop/car/PlateBlur/eval_metrics.json",
        help="Where to write machine-readable metrics.",
    )
    parser.add_argument(
        "--report-md",
        default="/Users/applemima111/Desktop/car/PlateBlur/EVALUATION_REPORT.md",
        help="Where to write the markdown evaluation report.",
    )
    parser.add_argument(
        "--country-crops",
        nargs="*",
        default=[
            "/Users/applemima111/Desktop/car/eval_data/unidatapro_germany/Germany.csv",
            "/Users/applemima111/Desktop/car/eval_data/unidatapro_netherlands/Netherlands.csv",
        ],
        help="Optional CSV files for cropped country smoke tests.",
    )
    parser.add_argument(
        "--scene-yolo-subsets",
        nargs="*",
        default=[
            "PP4AV Switzerland::/Users/applemima111/Desktop/car/eval_data/pp4av_switzerland/images::/Users/applemima111/Desktop/car/eval_data/pp4av_switzerland/labels"
        ],
        help="Optional scene-level YOLO subsets encoded as 'Name::images_dir::labels_dir'.",
    )
    return parser.parse_args()


def load_model(model_path: Path):
    return ct.models.MLModel(str(model_path))


def decode_prediction(
    result: Dict[str, np.ndarray],
    image_width: int,
    image_height: int,
    confidence_threshold: float,
) -> List[Prediction]:
    coordinates = np.array(result["coordinates"], dtype=np.float32)
    confidence = np.array(result["confidence"], dtype=np.float32)

    if coordinates.size == 0 or confidence.size == 0:
        return []

    coordinates = coordinates.reshape(-1, 4)
    confidence = confidence.reshape(coordinates.shape[0], -1)

    predictions: List[Prediction] = []
    for row_index, row in enumerate(coordinates):
        score = float(confidence[row_index].max())
        if score < confidence_threshold:
            continue

        center_x, center_y, width, height = row.tolist()
        x = max(0.0, (center_x - width / 2.0) * image_width)
        y = max(0.0, (center_y - height / 2.0) * image_height)
        w = min(float(image_width) - x, width * image_width)
        h = min(float(image_height) - y, height * image_height)
        if w <= 1 or h <= 1:
            continue
        predictions.append(Prediction(bbox_xywh=[x, y, w, h], score=score))

    return predictions


def predict_image(
    model,
    image_path: Path,
    confidence_threshold: float,
    iou_threshold: float,
) -> List[Prediction]:
    image = Image.open(image_path).convert("RGB")
    original_width, original_height = image.size
    resized = image.resize((640, 640))
    result = model.predict(
        {
            "image": resized,
            "confidenceThreshold": confidence_threshold,
            "iouThreshold": iou_threshold,
        }
    )
    return decode_prediction(result, original_width, original_height, confidence_threshold)


def sliding_positions(length: int, window: int, overlap: float) -> List[int]:
    if length <= window:
        return [0]

    stride = max(1, int(round(window * (1.0 - overlap))))
    positions = list(range(0, length - window + 1, stride))
    tail = length - window
    if positions[-1] != tail:
        positions.append(tail)
    return positions


def merge_predictions(predictions: List[Prediction], iou_threshold: float) -> List[Prediction]:
    kept: List[Prediction] = []
    for prediction in sorted(predictions, key=lambda item: item.score, reverse=True):
        if all(iou_xywh(prediction.bbox_xywh, existing.bbox_xywh) < iou_threshold for existing in kept):
            kept.append(prediction)
    return kept


def predict_tiled_image(
    model,
    image_path: Path,
    confidence_threshold: float,
    iou_threshold: float,
    tile_size: int,
    tile_overlap: float,
) -> List[Prediction]:
    image = Image.open(image_path).convert("RGB")
    width, height = image.size
    tile_predictions: List[Prediction] = []

    for y in sliding_positions(height, tile_size, tile_overlap):
        for x in sliding_positions(width, tile_size, tile_overlap):
            crop_width = min(tile_size, width - x)
            crop_height = min(tile_size, height - y)
            crop = image.crop((x, y, x + crop_width, y + crop_height))
            if crop.size != (640, 640):
                crop = crop.resize((640, 640))

            result = model.predict(
                {
                    "image": crop,
                    "confidenceThreshold": confidence_threshold,
                    "iouThreshold": iou_threshold,
                }
            )
            for prediction in decode_prediction(result, crop_width, crop_height, confidence_threshold):
                prediction.bbox_xywh[0] += x
                prediction.bbox_xywh[1] += y
                tile_predictions.append(prediction)

    return merge_predictions(tile_predictions, iou_threshold)


def build_predictor(args: argparse.Namespace, model) -> Callable[[Path], List[Prediction]]:
    tile_confidence_threshold = (
        args.confidence_threshold
        if args.tile_confidence_threshold < 0
        else args.tile_confidence_threshold
    )

    if args.inference_mode == "plain":
        return lambda image_path: predict_image(
            model=model,
            image_path=image_path,
            confidence_threshold=args.confidence_threshold,
            iou_threshold=args.iou_threshold,
        )

    if args.inference_mode == "tiled":
        return lambda image_path: predict_tiled_image(
            model=model,
            image_path=image_path,
            confidence_threshold=tile_confidence_threshold,
            iou_threshold=args.iou_threshold,
            tile_size=args.tile_size,
            tile_overlap=args.tile_overlap,
        )

    def hybrid_predictor(image_path: Path) -> List[Prediction]:
        full_frame_predictions = predict_image(
            model=model,
            image_path=image_path,
            confidence_threshold=args.confidence_threshold,
            iou_threshold=args.iou_threshold,
        )
        tile_predictions = predict_tiled_image(
            model=model,
            image_path=image_path,
            confidence_threshold=tile_confidence_threshold,
            iou_threshold=args.iou_threshold,
            tile_size=args.tile_size,
            tile_overlap=args.tile_overlap,
        )
        return merge_predictions(full_frame_predictions + tile_predictions, args.iou_threshold)

    return hybrid_predictor


def coco_results(
    coco: COCO,
    limit: int,
    image_path_for: Callable[[dict], Path],
    predictor: Callable[[Path], List[Prediction]],
):
    image_ids = coco.getImgIds()
    if limit > 0:
        image_ids = image_ids[:limit]

    predictions = []
    per_image_predictions: Dict[int, List[Prediction]] = {}
    latencies_ms: List[float] = []

    for image_id in image_ids:
        image_info = coco.loadImgs([image_id])[0]
        image_path = image_path_for(image_info)
        start = time.perf_counter()
        image_predictions = predictor(image_path)
        latencies_ms.append((time.perf_counter() - start) * 1000.0)
        per_image_predictions[image_id] = image_predictions

        for prediction in image_predictions:
            predictions.append(
                {
                    "image_id": image_id,
                    "category_id": 0,
                    "bbox": [round(v, 3) for v in prediction.bbox_xywh],
                    "score": round(prediction.score, 6),
                }
            )

    return image_ids, predictions, per_image_predictions, latencies_ms


def iou_xywh(box_a: Sequence[float], box_b: Sequence[float]) -> float:
    ax1, ay1, aw, ah = box_a
    bx1, by1, bw, bh = box_b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def compute_detection_f1(
    coco: COCO,
    image_ids: Iterable[int],
    per_image_predictions: Dict[int, List[Prediction]],
) -> Dict[str, float]:
    true_positive = 0
    false_positive = 0
    false_negative = 0
    image_hits = 0
    images_with_gt = 0

    for image_id in image_ids:
        annotations = coco.loadAnns(coco.getAnnIds(imgIds=[image_id]))
        gt_boxes = [annotation["bbox"] for annotation in annotations if annotation.get("iscrowd", 0) == 0]
        if gt_boxes:
            images_with_gt += 1

        predictions = sorted(per_image_predictions.get(image_id, []), key=lambda item: item.score, reverse=True)
        matched_gt = set()
        image_has_match = False

        for prediction in predictions:
            best_iou = 0.0
            best_gt_index = None
            for gt_index, gt_box in enumerate(gt_boxes):
                if gt_index in matched_gt:
                    continue
                overlap = iou_xywh(prediction.bbox_xywh, gt_box)
                if overlap > best_iou:
                    best_iou = overlap
                    best_gt_index = gt_index

            if best_gt_index is not None and best_iou >= 0.5:
                matched_gt.add(best_gt_index)
                true_positive += 1
                image_has_match = True
            else:
                false_positive += 1

        false_negative += max(0, len(gt_boxes) - len(matched_gt))
        if image_has_match:
            image_hits += 1

    precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) else 0.0
    recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    image_recall = image_hits / images_with_gt if images_with_gt else 0.0

    return {
        "precision_iou50": precision,
        "recall_iou50": recall,
        "f1_iou50": f1,
        "image_recall_iou50": image_recall,
        "true_positive": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
    }


def zero_coco_metrics() -> Dict[str, float]:
    return {
        "coco_ap50_95": 0.0,
        "coco_ap50": 0.0,
        "coco_ap75": 0.0,
        "coco_ar100": 0.0,
    }


def summarize_coco_eval(coco: COCO, predictions: List[Dict[str, object]], image_ids: List[int]) -> Dict[str, float]:
    if not predictions:
        return zero_coco_metrics()

    coco_dt = coco.loadRes(predictions)
    evaluator = COCOeval(coco, coco_dt, "bbox")
    evaluator.params.imgIds = image_ids
    evaluator.evaluate()
    evaluator.accumulate()
    evaluator.summarize()
    return {
        "coco_ap50_95": float(evaluator.stats[0]),
        "coco_ap50": float(evaluator.stats[1]),
        "coco_ap75": float(evaluator.stats[2]),
        "coco_ar100": float(evaluator.stats[8]),
    }


def evaluate_coco_dataset(args: argparse.Namespace) -> Dict[str, float]:
    dataset_dir = Path(args.dataset_dir)
    annotation_path = dataset_dir / "_annotations.coco.json"
    coco = COCO(str(annotation_path))
    model = load_model(Path(args.model))
    predictor = build_predictor(args, model)

    image_ids, predictions, per_image_predictions, latencies_ms = coco_results(
        coco=coco,
        limit=args.limit,
        image_path_for=lambda image_info: dataset_dir / image_info["file_name"],
        predictor=predictor,
    )

    detection_summary = compute_detection_f1(coco, image_ids, per_image_predictions)
    coco_metrics = summarize_coco_eval(coco, predictions, image_ids)

    return {
        "images_evaluated": len(image_ids),
        "avg_latency_ms": statistics.mean(latencies_ms),
        "p95_latency_ms": statistics.quantiles(latencies_ms, n=20)[18] if len(latencies_ms) >= 20 else max(latencies_ms),
        "empty_prediction_images": sum(1 for items in per_image_predictions.values() if not items),
        **coco_metrics,
        **detection_summary,
    }


def evaluate_country_crop_csv(csv_path: Path, predictor: Callable[[Path], List[Prediction]]) -> Dict[str, float]:
    rows = list(csv.DictReader(csv_path.read_text(encoding="utf-8").splitlines()))
    hits = 0
    scores: List[float] = []

    for row in rows:
        image_path = csv_path.parent / row["File"]
        predictions = predictor(image_path)
        if predictions:
            hits += 1
            scores.append(max(prediction.score for prediction in predictions))
        else:
            scores.append(0.0)

    return {
        "images": len(rows),
        "hit_rate": hits / len(rows) if rows else 0.0,
        "avg_top_score": statistics.mean(scores) if scores else 0.0,
    }


def build_coco_from_yolo_subset(images_dir: Path, labels_dir: Path) -> COCO:
    image_paths = sorted(
        path for path in images_dir.iterdir()
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}
    )

    images = []
    annotations = []
    annotation_id = 1

    for image_id, image_path in enumerate(image_paths, start=1):
        with Image.open(image_path) as image:
            width, height = image.size

        images.append(
            {
                "id": image_id,
                "file_name": image_path.name,
                "width": width,
                "height": height,
            }
        )

        label_path = labels_dir / f"{image_path.stem}.txt"
        if not label_path.exists():
            continue

        for line in label_path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if len(parts) < 5:
                continue

            class_id = int(float(parts[0]))
            if class_id != 1:
                continue

            center_x, center_y, box_width, box_height = map(float, parts[1:5])
            bbox_width = box_width * width
            bbox_height = box_height * height
            bbox_x = (center_x - box_width / 2.0) * width
            bbox_y = (center_y - box_height / 2.0) * height

            annotations.append(
                {
                    "id": annotation_id,
                    "image_id": image_id,
                    "category_id": 0,
                    "bbox": [bbox_x, bbox_y, bbox_width, bbox_height],
                    "area": bbox_width * bbox_height,
                    "iscrowd": 0,
                }
            )
            annotation_id += 1

    coco = COCO()
    coco.dataset = {
        "images": images,
        "annotations": annotations,
        "categories": [{"id": 0, "name": "license_plate"}],
    }
    coco.createIndex()
    return coco


def evaluate_yolo_scene_subset(
    name: str,
    images_dir: Path,
    labels_dir: Path,
    predictor: Callable[[Path], List[Prediction]],
) -> Dict[str, float]:
    coco = build_coco_from_yolo_subset(images_dir, labels_dir)
    image_ids, predictions, per_image_predictions, latencies_ms = coco_results(
        coco=coco,
        limit=0,
        image_path_for=lambda image_info: images_dir / image_info["file_name"],
        predictor=predictor,
    )

    detection_summary = compute_detection_f1(coco, image_ids, per_image_predictions)
    coco_metrics = summarize_coco_eval(coco, predictions, image_ids)

    return {
        "images_evaluated": len(image_ids),
        "avg_latency_ms": statistics.mean(latencies_ms),
        "p95_latency_ms": statistics.quantiles(latencies_ms, n=20)[18] if len(latencies_ms) >= 20 else max(latencies_ms),
        "empty_prediction_images": sum(1 for items in per_image_predictions.values() if not items),
        "name": name,
        **coco_metrics,
        **detection_summary,
    }


def build_markdown_report(
    coco_metrics: Dict[str, float],
    scene_metrics: Dict[str, Dict[str, float]],
    country_metrics: Dict[str, Dict[str, float]],
    args: argparse.Namespace,
) -> str:
    lines = [
        "# PlateBlur Evaluation Report",
        "",
        f"- Model: `{args.model}`",
        f"- Dataset: `{args.dataset_dir}`",
        f"- Confidence threshold: `{args.confidence_threshold}`",
        f"- IoU threshold: `{args.iou_threshold}`",
        f"- Inference mode: `{args.inference_mode}`",
        f"- Tile size: `{args.tile_size}`",
        f"- Tile overlap: `{args.tile_overlap}`",
        f"- Tile confidence threshold: `{args.confidence_threshold if args.tile_confidence_threshold < 0 else args.tile_confidence_threshold}`",
        "",
        "## COCO Detection Metrics",
        "",
        f"- Images evaluated: `{coco_metrics['images_evaluated']}`",
        f"- `AP@[0.50:0.95]`: `{coco_metrics['coco_ap50_95']:.4f}`",
        f"- `AP@0.50`: `{coco_metrics['coco_ap50']:.4f}`",
        f"- `AP@0.75`: `{coco_metrics['coco_ap75']:.4f}`",
        f"- `AR@100`: `{coco_metrics['coco_ar100']:.4f}`",
        f"- `Precision@IoU0.50`: `{coco_metrics['precision_iou50']:.4f}`",
        f"- `Recall@IoU0.50`: `{coco_metrics['recall_iou50']:.4f}`",
        f"- `F1@IoU0.50`: `{coco_metrics['f1_iou50']:.4f}`",
        f"- Image recall@IoU0.50: `{coco_metrics['image_recall_iou50']:.4f}`",
        f"- Average latency per image: `{coco_metrics['avg_latency_ms']:.2f} ms`",
        f"- P95 latency per image: `{coco_metrics['p95_latency_ms']:.2f} ms`",
        f"- Images with no predictions: `{int(coco_metrics['empty_prediction_images'])}`",
        "",
        "## Scene-Level Public Validation Sets",
        "",
        "These subsets keep full driving-scene context, so they are better indicators of real-world anonymization performance than cropped-plate smoke tests.",
        "",
    ]

    for scene_name, metrics in scene_metrics.items():
        lines.extend(
            [
                f"### {scene_name}",
                "",
                f"- Images evaluated: `{int(metrics['images_evaluated'])}`",
                f"- `AP@[0.50:0.95]`: `{metrics['coco_ap50_95']:.4f}`",
                f"- `AP@0.50`: `{metrics['coco_ap50']:.4f}`",
                f"- `AP@0.75`: `{metrics['coco_ap75']:.4f}`",
                f"- `AR@100`: `{metrics['coco_ar100']:.4f}`",
                f"- `Precision@IoU0.50`: `{metrics['precision_iou50']:.4f}`",
                f"- `Recall@IoU0.50`: `{metrics['recall_iou50']:.4f}`",
                f"- `F1@IoU0.50`: `{metrics['f1_iou50']:.4f}`",
                f"- Image recall@IoU0.50: `{metrics['image_recall_iou50']:.4f}`",
                f"- Average latency per image: `{metrics['avg_latency_ms']:.2f} ms`",
                f"- P95 latency per image: `{metrics['p95_latency_ms']:.2f} ms`",
                f"- Images with no predictions: `{int(metrics['empty_prediction_images'])}`",
                "",
            ]
        )

    lines.extend(
        [
            "## Country Crop Smoke Tests",
            "",
            "These small public datasets are cropped plate photos, so they are useful as region-support smoke tests, not as full-scene detection benchmarks.",
            "",
        ]
    )

    for country_name, metrics in country_metrics.items():
        lines.extend(
            [
                f"### {country_name}",
                "",
                f"- Images: `{int(metrics['images'])}`",
                f"- Detector hit rate: `{metrics['hit_rate']:.4f}`",
                f"- Average top score: `{metrics['avg_top_score']:.4f}`",
                "",
            ]
        )

    return "\n".join(lines).strip() + "\n"


def main() -> None:
    args = parse_args()
    coco_metrics = evaluate_coco_dataset(args)

    model = load_model(Path(args.model))
    predictor = build_predictor(args, model)
    scene_metrics: Dict[str, Dict[str, float]] = {}
    for entry in args.scene_yolo_subsets:
        try:
            name, images_dir_raw, labels_dir_raw = entry.split("::", 2)
        except ValueError:
            continue

        images_dir = Path(images_dir_raw)
        labels_dir = Path(labels_dir_raw)
        if not images_dir.exists() or not labels_dir.exists():
            continue

        scene_metrics[name] = evaluate_yolo_scene_subset(
            name=name,
            images_dir=images_dir,
            labels_dir=labels_dir,
            predictor=predictor,
        )

    country_metrics: Dict[str, Dict[str, float]] = {}
    for csv_entry in args.country_crops:
        csv_path = Path(csv_entry)
        if not csv_path.exists():
            continue
        country_metrics[csv_path.stem] = evaluate_country_crop_csv(csv_path, predictor=predictor)

    metrics_payload = {
        "coco_metrics": coco_metrics,
        "scene_metrics": scene_metrics,
        "country_crop_metrics": country_metrics,
    }
    Path(args.report_json).write_text(json.dumps(metrics_payload, indent=2), encoding="utf-8")
    Path(args.report_md).write_text(
        build_markdown_report(coco_metrics, scene_metrics, country_metrics, args),
        encoding="utf-8",
    )
    print(json.dumps(metrics_payload, indent=2))


if __name__ == "__main__":
    main()
