#!/usr/bin/env python3
"""
Decode the largest DataMatrix on an image and print its bytes (base64) to stdout.
Usage: decode_datamatrix.py <image_path>
"""
import base64
import sys

from PIL import Image
from pylibdmtx.pylibdmtx import decode


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: decode_datamatrix.py <image>", file=sys.stderr)
        return 2

    img = Image.open(sys.argv[1]).convert("RGB")
    # try a few timeouts / shrink factors for tough scans
    results = decode(img, timeout=8000, max_count=1)
    if not results:
        # Retry on a downscaled copy — sometimes helps with noisy 450-dpi rasters.
        w, h = img.size
        small = img.resize((w // 2, h // 2), Image.LANCZOS)
        results = decode(small, timeout=8000, max_count=1)

    if not results:
        print("DECODE_FAILED", file=sys.stderr)
        return 1

    # Pick the largest detection.
    best = max(results, key=lambda r: r.rect.width * r.rect.height)
    sys.stdout.write(base64.b64encode(best.data).decode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
