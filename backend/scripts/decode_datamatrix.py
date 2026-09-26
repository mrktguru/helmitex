#!/usr/bin/env python3
"""
Decode the largest DataMatrix on an image and print its bytes (base64).

One-shot:  decode_datamatrix.py <image_path>
Server:    decode_datamatrix.py --serve
           Reads one image path per line from stdin and answers one line per
           request on stdout: "OK <base64>" or "ERR <message>". Keeps the
           interpreter (and PIL / pylibdmtx imports, ~0.5 s) alive between
           images, which is what makes bulk generation fast.
"""
import base64
import sys

from PIL import Image
from pylibdmtx.pylibdmtx import decode


def decode_file(path: str) -> bytes:
    img = Image.open(path).convert("RGB")
    # try a few timeouts / shrink factors for tough scans
    results = decode(img, timeout=8000, max_count=1)
    if not results:
        # Retry on a downscaled copy — sometimes helps with noisy 450-dpi rasters.
        w, h = img.size
        small = img.resize((w // 2, h // 2), Image.LANCZOS)
        results = decode(small, timeout=8000, max_count=1)

    if not results:
        raise ValueError("DECODE_FAILED")

    # Pick the largest detection.
    best = max(results, key=lambda r: r.rect.width * r.rect.height)
    return best.data


def serve() -> int:
    for line in sys.stdin:
        path = line.rstrip("\r\n")
        if not path:
            continue
        try:
            out = "OK " + base64.b64encode(decode_file(path)).decode("ascii")
        except Exception as e:  # keep the process alive for the next request
            out = "ERR " + " ".join(str(e).split())
        sys.stdout.write(out + "\n")
        sys.stdout.flush()
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: decode_datamatrix.py <image> | --serve", file=sys.stderr)
        return 2
    if sys.argv[1] == "--serve":
        return serve()

    try:
        data = decode_file(sys.argv[1])
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1
    sys.stdout.write(base64.b64encode(data).decode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
