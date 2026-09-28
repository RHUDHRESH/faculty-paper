"""Split a ChatGPT banner sheet (strips stacked vertically, separated by
near-white bands) into separate banners, keeping the flat background.
Usage: split-banner-strips.py <raw.png> name1,name2,name3"""
import importlib.util
import sys
from pathlib import Path

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("p", Path(__file__).with_name("process-generated-art.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

im = Image.open(sys.argv[1]).convert("RGB")
names = sys.argv[2].split(",")
a = np.asarray(im).astype(float)
white = np.where((a.min(-1) >= 250).mean(1) > 0.95)[0]
cuts = []
for r in white:
    if not cuts or r - cuts[-1][1] > 1:
        cuts.append([r, r])
    else:
        cuts[-1][1] = r
edges = [0] + [c for s in cuts for c in (s[0], s[1] + 1)] + [im.height]
strips = [(edges[i], edges[i + 1]) for i in range(0, len(edges), 2) if edges[i + 1] - edges[i] > 50]
for (y0, y1), n in zip(strips, names):
    print(n, p.process(im.crop((0, y0 + 2, im.width, y1 - 2)), n, False, True, False, 1600))
