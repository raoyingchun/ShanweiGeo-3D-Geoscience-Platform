"""Download the published Web Version folder from GitHub.

Node's fetch ignores the system proxy on this machine, so the download runs
here with urllib and the explicit proxy that works.
"""
import os, sys, io, json, ssl, urllib.request, urllib.error, time
import certifi

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

RAW = "https://raw.githubusercontent.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/main/Web%20Version"
API = "https://api.github.com/repos/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/git/trees/main?recursive=1"
DEST = os.path.join(os.environ.get("TEMP", "/tmp"), "shanwei_remote_check")
PROXY = "http://127.0.0.1:7890"

ctx = ssl.create_default_context(cafile=certifi.where())
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}),
    urllib.request.HTTPSHandler(context=ctx))

# remove the previous copy
import shutil
shutil.rmtree(DEST, ignore_errors=True)
os.makedirs(DEST, exist_ok=True)

req = urllib.request.Request(API, headers={"User-Agent": "check"})
tree = json.loads(opener.open(req, timeout=120).read().decode("utf-8"))
paths = [e["path"][len("Web Version/"):] for e in tree["tree"]
         if e["type"] == "blob" and e["path"].startswith("Web Version/")]
print("published files: %d" % len(paths))

ok = 0
failed = []
for i, p in enumerate(paths):
    url = RAW + "/" + "/".join(urllib.request.quote(seg, safe="")
                               for seg in p.split("/"))
    target = os.path.join(DEST, p.replace("/", os.sep))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    for attempt in range(3):
        try:
            data = opener.open(url, timeout=180).read()
            with open(target, "wb") as f:
                f.write(data)
            ok += 1
            break
        except Exception as e:
            if attempt == 2:
                failed.append((p, str(e)[:70]))
    if (i + 1) % 40 == 0:
        print("  %d / %d" % (i + 1, len(paths)))

print("downloaded %d / %d" % (ok, len(paths)))
for p, e in failed[:10]:
    print("  FAIL %s :: %s" % (p, e))

with open(os.path.join(DEST, "_download_result.json"), "w", encoding="utf-8") as f:
    json.dump({"expected": len(paths), "ok": ok, "failed": [p for p, _ in failed]}, f)
print("destination: " + DEST)
sys.exit(0 if ok == len(paths) else 1)
