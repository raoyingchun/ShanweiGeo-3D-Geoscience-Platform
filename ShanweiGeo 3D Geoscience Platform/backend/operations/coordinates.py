"""Offline coordinate operations. Geographic columns are B,L,h; grid columns X(N),Y(E),h."""
import csv
import io
import math
import re
import numpy as np
from pyproj import CRS, Transformer, network

network.set_network_enabled(False)
ELLIPSOIDS = {
    "WGS84": (6378137.0, 298.257223563),
    "CGCS2000": (6378137.0, 298.257222101),
    "BJ54": (6378245.0, 298.3),
    "XA80": (6378140.0, 298.257),
}
ARCSEC = math.pi / (180 * 3600)


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Coordinates and parameters must be finite numbers')
    return result


def angle(value):
    text = str(value).strip().upper()
    if ':' not in text:
        return number(text)
    suffix = text[-1:] if text[-1:] in "NSEW" else ""
    if suffix:
        text = text[:-1]
    parts = text.split(':')
    if len(parts) != 3:
        raise ValueError('Use decimal degrees or degrees:minutes:seconds for angles')
    deg, minute, second = map(number, parts)
    if not 0 <= minute < 60 or not 0 <= second < 60:
        raise ValueError('Minutes and seconds must be in the range 0 to 60')
    sign = -1 if deg < 0 or text.startswith('-') or suffix in ('S', 'W') else 1
    return sign * (abs(deg) + minute / 60 + second / 3600)


def rows_from_text(text, columns):
    rows = []
    for line_no, line in enumerate(str(text).splitlines(), 1):
        line = line.strip().lstrip('\ufeff')
        if not line or line.startswith('#'):
            continue
        fields = next(csv.reader([line])) if ',' in line else re.split(r'[;\t ]+', line)
        fields = [field.strip() for field in fields]
        name = str(len(rows) + 1)
        if len(fields) == columns + 1:
            name, fields = fields[0], fields[1:]
        if len(fields) != columns:
            raise ValueError(f"第 {line_no} 行需要 {columns} 个坐标值，可在前面附加点号")
        rows.append((name, fields))
    if not rows:
        raise ValueError('Enter coordinate data first')
    if len(rows) > 5000:
        raise ValueError('At most 5,000 rows per operation; process in batches')
    return rows


def crs(config):
    key = config.get('ellipsoid', 'WGS84')
    if key not in ELLIPSOIDS:
        raise ValueError('Unsupported ellipsoid')
    a, rf = ELLIPSOIDS[key]
    kind = config.get('type', 'blh')
    ell = f'+a={a} +rf={rf}'
    if kind == 'blh':
        return CRS.from_proj4(f'+proj=longlat {ell} +type=crs')
    if kind == 'xyz':
        return CRS.from_proj4(f'+proj=geocent {ell} +units=m +type=crs')
    if kind != 'xyh':
        raise ValueError('Unsupported coordinate type')
    lon0 = number(config.get('lon0', 111))
    lat0 = number(config.get('lat0', 0))
    k0 = number(config.get('k0', 1))
    if not -180 <= lon0 <= 180 or not -89 < lat0 < 89 or k0 <= 0:
        raise ValueError('Projection parameters are outside the valid range')
    x0 = number(config.get('x0', 0))
    y0 = number(config.get('y0', 500000))
    return CRS.from_proj4(f'+proj=tmerc {ell} +lon_0={lon0} +lat_0={lat0} +k_0={k0} +x_0={y0} +y_0={x0} +units=m +type=crs')


def to_ecef(values, config):
    kind = config.get('type', 'blh')
    if kind == 'blh':
        b, l, h = angle(values[0]), angle(values[1]), number(values[2])
        if not -90 <= b <= 90 or not -180 <= l <= 180:
            raise ValueError('Latitude or longitude is out of range')
        vals = (l, b, h)
    elif kind == 'xyh':
        vals = (number(values[1]), number(values[0]), number(values[2]))
    else:
        vals = tuple(map(number, values))
    geo = dict(config, type='xyz')
    return np.array(Transformer.from_crs(crs(config), crs(geo), always_xy=True).transform(*vals, errcheck=True))


def from_ecef(values, config):
    if np.linalg.norm(values) < 1:
        raise ValueError('Coordinates are too close to the geocenter to determine latitude and longitude')
    vals = Transformer.from_crs(crs(dict(config, type='xyz')), crs(config), always_xy=True).transform(*values, errcheck=True)
    if config.get('type', 'blh') in ('blh', 'xyh'):
        vals = (vals[1], vals[0], vals[2])
    return list(map(number, vals))


def helmert_matrix(params):
    sign = -1 if params.get('convention') == 'coordinate_frame' else 1
    if params.get('convention', 'position_vector') not in ('position_vector', 'coordinate_frame'):
        raise ValueError('Unknown rotation convention')
    rx, ry, rz = [sign * number(params.get(k, 0)) * ARCSEC for k in ('rx', 'ry', 'rz')]
    scale = 1 + number(params.get('ppm', 0)) * 1e-6
    if abs(scale) < 1e-10:
        raise ValueError('The scale factor cannot be zero')
    matrix = scale * np.array([[1, -rz, ry], [rz, 1, -rx], [-ry, rx, 1]], dtype=float)
    shift = np.array([number(params.get(k, 0)) for k in ('dx', 'dy', 'dz')])
    return matrix, shift


def convert(params, emit):
    source, target = params['source'], params['target']
    helmert = params.get('helmert')
    reverse = bool(params.get('reverse'))
    if source.get('ellipsoid') != target.get('ellipsoid') and helmert is None:
        raise ValueError('A local three- or seven-parameter transformation is required between datums; changing the ellipsoid name is insufficient')
    if reverse:
        source, target = target, source
    matrix, shift = helmert_matrix(helmert or {})
    rows = rows_from_text(params.get('text', ''), 3)
    output = []
    for index, (name, values) in enumerate(rows):
        xyz = to_ecef(values, source)
        xyz = np.linalg.solve(matrix, xyz - shift) if reverse else matrix @ xyz + shift
        output.append([name] + from_ecef(xyz, target))
        if (index + 1) % 100 == 0:
            emit({'type': 'progress', 'percent': round((index + 1) * 100 / len(rows)), 'message': 'Converting coordinates'})
    kind = target.get('type', 'blh')
    labels = {'blh': ['B(Degrees)', 'L(Degrees)', 'h(m)'], 'xyh': ['XNorth(m)', 'YEast(m)', 'h(m)'], 'xyz': ['X(m)', 'Y(m)', 'Z(m)']}
    return {'headers': ['Point ID'] + labels[kind], 'rows': output, 'count': len(output)}


def plane_matrix(params):
    theta = number(params.get('rotation', 0)) * ARCSEC
    scale = 1 + number(params.get('ppm', 0)) * 1e-6
    if abs(scale) < 1e-10:
        raise ValueError('The scale factor cannot be zero')
    return scale * np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]]), np.array([number(params.get('dx', 0)), number(params.get('dy', 0))])


def plane_convert(params, emit):
    matrix, shift = plane_matrix(params.get('parameters', {}))
    output = []
    for name, row in rows_from_text(params.get('text', ''), 3):
        xy = np.array(list(map(number, row[:2])))
        xy = np.linalg.solve(matrix, xy - shift) if params.get('reverse') else matrix @ xy + shift
        output.append([name, *map(float, xy), number(row[2])])
    return {'headers': ['Point ID', 'X(m)', 'Y(m)', 'Original height(m)'], 'rows': output, 'count': len(output)}


def fit(params, emit):
    mode = params.get('mode', 'four')
    dim = 2 if mode == 'four' else 3
    if mode not in ('four', 'three', 'seven'):
        raise ValueError('Unsupported fitting method')
    rows = rows_from_text(params.get('text', ''), dim * 2)
    minimum = {'four': 2, 'three': 1, 'seven': 3}[mode]
    if len(rows) < minimum:
        raise ValueError(f"该方法至少需要 {minimum} 个公共点")
    if mode == 'four':
        src = np.array([[number(v) for v in r[:2]] for _, r in rows])
        dst = np.array([[number(v) for v in r[2:]] for _, r in rows])
    else:
        src = np.array([to_ecef(r[:3], params['source']) for _, r in rows])
        dst = np.array([to_ecef(r[3:], params['target']) for _, r in rows])
    origin, goal = src.mean(axis=0), dst.mean(axis=0)
    centered, target_centered = src - origin, dst - goal
    if mode == 'three':
        shift = goal - origin
        predicted = src + shift
        result = dict(zip(('dx', 'dy', 'dz'), map(float, shift)))
        result.update(rx=0, ry=0, rz=0, ppm=0, convention='position_vector')
    elif mode == 'four':
        denominator = float(np.sum(centered ** 2))
        if denominator < 1e-12:
            raise ValueError('Coincident common points prevent four-parameter estimation')
        a = float(np.sum(centered * target_centered)) / denominator
        b = float(np.sum(centered[:, 0] * target_centered[:, 1] - centered[:, 1] * target_centered[:, 0])) / denominator
        matrix = np.array([[a, -b], [b, a]])
        shift = goal - matrix @ origin
        predicted = src @ matrix.T + shift
        result = {'dx': float(shift[0]), 'dy': float(shift[1]), 'rotation': math.atan2(b, a) / ARCSEC, 'ppm': (math.hypot(a, b) - 1) * 1e6}
    else:
        spread = float(np.sqrt(np.mean(centered ** 2)))
        if spread < 1e-8:
            raise ValueError('Coincident common points prevent seven-parameter estimation')
        design = []
        for x, y, z in centered / spread:
            design.extend([[x, 0, z, -y], [y, -z, 0, x], [z, y, -x, 0]])
        coeff, _, rank, _ = np.linalg.lstsq(np.array(design), ((target_centered - centered) / spread).ravel(), rcond=None)
        if rank < 4:
            raise ValueError('Degenerate control-point geometry prevents a unique seven-parameter estimate')
        scale, qx, qy, qz = coeff
        m = 1 + scale
        if abs(m) < 1e-10:
            raise ValueError('Invalid fitted scale')
        result = {'dx': 0, 'dy': 0, 'dz': 0, 'rx': qx / m / ARCSEC, 'ry': qy / m / ARCSEC, 'rz': qz / m / ARCSEC, 'ppm': scale * 1e6, 'convention': 'position_vector'}
        matrix, _ = helmert_matrix(result)
        shift = goal - matrix @ origin
        result.update(dict(zip(('dx', 'dy', 'dz'), map(float, shift))))
        predicted = src @ matrix.T + shift
    residual = predicted - dst
    rms = float(np.sqrt(np.mean(np.sum(residual ** 2, axis=1))))
    return {'parameters': result, 'rms': rms, 'headers': ['Point ID'] + [f'd{a}(米)' for a in ('X', 'Y', 'Z')[:dim]] + ['Point residual (m)'],
            'rows': [[name, *map(float, err), float(np.linalg.norm(err))] for (name, _), err in zip(rows, residual)],
            'count': len(rows), 'note': 'Residual = computed minus target value. RMS is the root mean square of per-point residual vectors. Three- and seven-parameter residuals use geocentric Cartesian coordinates.'}


def dispatch(method, params, emit):
    return {'coord.convert': convert, 'coord.plane': plane_convert, 'coord.fit': fit}[method](params, emit)
