"""One task per process; stdout exclusively contains UTF-8 JSON Lines."""
import json
import sys
import time
import traceback
from operations.health import check


def send(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main():
    try:
        request = json.loads(sys.stdin.readline())
        method = request.get("method")
        params = request.get("params", {})
        if method == 'terrain.parse':
            from operations.terrain import run
            result = run(params, send)
        elif method == 'block.parse':
            from operations.blocks import run
            result = run(params, send)
        elif method == 'model.parse':
            from operations.geometry import run
            result = run(params, send)
        elif method == 'coord.native.convert':
            from operations.coord_native import convert
            result = convert(params, send)
        elif method == 'coord.native.batch':
            from operations.coord_native import batch
            result = batch(params, send)
        elif method == "health.check":
            result = check()
        elif method == "diagnostic.progress":
            steps = params.get("steps", 10)
            if type(steps) is not int or not 1 <= steps <= 100:
                raise ValueError('steps must be an integer from 1 to 100')
            for step in range(steps):
                time.sleep(0.1)
                send({"type": "progress", "percent": round((step + 1) * 100 / steps), "message": 'Running local diagnostics'})
            result = {"status": "ok", "steps": steps}
        elif method == "diagnostic.error":
            raise ValueError('Expected diagnostic error')
        else:
            raise ValueError('Unsupported operation')
        send({"type": "result", "data": result})
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        send({"type": "error", "error": {"code": "BACKEND_ERROR", "message": str(exc)}})
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv)>1 and sys.argv[1]=='--cleanup-coord':
        from operations.coord_native import cleanup_copies
        print(json.dumps({'cleaned':cleanup_copies(sys.argv[2:])}),flush=True)
        raise SystemExit(0)
    raise SystemExit(main())
