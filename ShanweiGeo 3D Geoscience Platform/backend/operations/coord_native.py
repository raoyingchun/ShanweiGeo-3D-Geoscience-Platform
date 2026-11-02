"""Web facade for the original COORD. No coordinate algorithms are implemented here."""
import ctypes
import codecs
from ctypes import wintypes as w
import math
import re
import shutil
import tempfile
import time
import os
import sys
from pathlib import Path


def _resolve_coord_dir():
    """Locate the original COORD installation.

    The main process passes SHANWEI_COORD_DIR. When it is absent, fall back to
    the userData/tools/COORD location the packaged build uses, then to a
    COORD folder next to the backend sources. No machine-specific path is
    hard-coded, so the sources stay portable.
    """
    from_env = os.environ.get('SHANWEI_COORD_DIR')
    if from_env:
        return Path(from_env)
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent.parent / 'userData' / 'tools' / 'COORD',
        here.parent.parent.parent / 'tools' / 'COORD',
    ]
    for candidate in candidates:
        if (candidate / 'COORD.exe').is_file():
            return candidate
    # Nothing found: return the first candidate so the caller reports a
    # directory name it can act on.
    return candidates[0]


COORD_DIR = _resolve_coord_dir()
SOURCE_IDS = {'xyz': 1022, 'blh': 1024, 'xyh': 1027}
TARGET_IDS = {'xyz': 1025, 'blh': 1026, 'xyh': 1028}
PROJECTION_MODES = {'gauss3': 0, 'gauss6': 1, 'custom': 2, 'utm': 4}
PROJECTION_NAMES = {0: '高斯三度带投影', 1: '高斯六度带投影', 2: '自定义高斯投影', 4: 'UTM投影'}
ELLIPSOIDS = {'BJ54': 0, 'XA80': 1, 'WGS84': 2, 'CGCS2000': 3}
EXPECTED_ELLIPSOIDS = ['北京54', '国家80', 'WGS84', 'CGCS2000']
FILE_FORMATS = [
    ('XYH空格txt (*.TXT)', 'txt', 'cartesian'), ('XYH逗号txt (*.TXT)', 'txt', 'cartesian'),
    ('BLH空格txt (*.txt)', 'txt', 'blh'), ('BLH逗号txt (*.txt)', 'txt', 'blh'),
    ('平面逗号CSV (*.CSV)', 'csv', 'cartesian'), ('CAD (*.dat)', 'dat', 'cartesian')
]


class BasicLimit(ctypes.Structure):
    _fields_ = [('userTime', ctypes.c_longlong), ('kernelTime', ctypes.c_longlong),
                ('flags', w.DWORD), ('minWorkingSet', ctypes.c_size_t), ('maxWorkingSet', ctypes.c_size_t),
                ('activeLimit', w.DWORD), ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]


class IOCounters(ctypes.Structure):
    _fields_ = [(key, ctypes.c_ulonglong) for key in ['readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes']]


class ExtendedLimit(ctypes.Structure):
    _fields_ = [('basic', BasicLimit), ('io', IOCounters), ('processMemory', ctypes.c_size_t),
                ('jobMemory', ctypes.c_size_t), ('peakProcess', ctypes.c_size_t), ('peakJob', ctypes.c_size_t)]


class StartupInfo(ctypes.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR), ('title', w.LPWSTR),
                ('x', w.DWORD), ('y', w.DWORD), ('xSize', w.DWORD), ('ySize', w.DWORD),
                ('xChars', w.DWORD), ('yChars', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                ('show', w.WORD), ('reservedSize', w.WORD), ('reserved2', ctypes.POINTER(ctypes.c_byte)),
                ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]


class CoordSession:
    def __init__(self, file_format=None):
        if not hasattr(ctypes, 'WinDLL'):
            raise RuntimeError('Legacy COORD integration supports Windows only')
        self.u = ctypes.WinDLL('user32', use_last_error=True)
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        self.callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        signatures = {
            'SendMessageTimeoutW': ([w.HWND, w.UINT, w.WPARAM, w.LPARAM, w.UINT, w.UINT, ctypes.POINTER(ctypes.c_size_t)], w.LPARAM),
            'EnumWindows': ([self.callback_type, w.LPARAM], w.BOOL),
            'EnumChildWindows': ([w.HWND, self.callback_type, w.LPARAM], w.BOOL),
            'GetWindowThreadProcessId': ([w.HWND, ctypes.POINTER(w.DWORD)], w.DWORD),
            'GetClassNameW': ([w.HWND, w.LPWSTR, ctypes.c_int], ctypes.c_int),
            'GetDlgCtrlID': ([w.HWND], ctypes.c_int), 'IsWindow': ([w.HWND], w.BOOL),
            'IsWindowVisible': ([w.HWND], w.BOOL), 'IsWindowEnabled': ([w.HWND], w.BOOL),
            'ShowWindow': ([w.HWND, ctypes.c_int], w.BOOL),
            'PostMessageW': ([w.HWND, w.UINT, w.WPARAM, w.LPARAM], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.u, name); function.argtypes = args; function.restype = result
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
            'SetInformationJobObject': ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD], w.BOOL),
            'CreateProcessW': ([w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD,
                                ctypes.c_void_p, w.LPCWSTR, ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)], w.BOOL),
            'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
            'ResumeThread': ([w.HANDLE], w.DWORD), 'CloseHandle': ([w.HANDLE], w.BOOL),
            'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
            'TerminateProcess': ([w.HANDLE, w.UINT], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.k, name); function.argtypes = args; function.restype = result
        self.temp = None; self.job = None; self.process = None; self.main = None; self.pid = None; self.modal = None
        self.file_format_index=file_format

    def class_name(self, hwnd):
        buffer = ctypes.create_unicode_buffer(256); self.u.GetClassNameW(hwnd, buffer, len(buffer)); return buffer.value

    def owned(self, hwnd):
        pid = w.DWORD(); self.u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid)); return pid.value == self.pid

    def windows(self, parent=None):
        result = []
        @self.callback_type
        def collect(hwnd, _):
            if self.owned(hwnd): result.append(hwnd)
            return True
        if parent is None: self.u.EnumWindows(collect, 0)
        else: self.u.EnumChildWindows(parent, collect, 0)
        return result

    def send(self, hwnd, message, wp=0, lp=0):
        if not self.u.IsWindow(hwnd) or not self.owned(hwnd): raise RuntimeError('The COORD window has closed')
        result = ctypes.c_size_t()
        if not self.u.SendMessageTimeoutW(hwnd, message, wp, lp, 2, 1200, ctypes.byref(result)):
            raise RuntimeError('COORD control response timed out')
        # Legacy handlers can show their dialog again when changing a selection.
        if self.main and self.u.IsWindowVisible(self.main): self.u.ShowWindow(self.main, 0)
        if self.modal and self.u.IsWindowVisible(self.modal): self.u.ShowWindow(self.modal, 0)
        return result.value

    def text(self, hwnd):
        buffer = ctypes.create_unicode_buffer(4096); self.send(hwnd, 0xD, len(buffer), ctypes.addressof(buffer)); return buffer.value

    def control(self, cid, cls, parent=None):
        found = [h for h in self.windows(parent or self.main) if self.u.GetDlgCtrlID(h) == cid and self.class_name(h) == cls]
        if len(found) != 1: raise RuntimeError(f'COORD 控件 {cid} 不匹配，请确认原软件版本')
        return found[0]

    def start(self):
        if not (COORD_DIR / 'COORD.exe').is_file():
            raise RuntimeError(f'COORD.exe was not found in the configured directory: {COORD_DIR}')
        self.temp = tempfile.TemporaryDirectory(prefix='shanwei-coord-')
        directory = Path(self.temp.name) / 'COORD'
        shutil.copytree(COORD_DIR, directory)
        if self.file_format_index==4:
            # The shipped CSV preset uses a full-width delimiter that its ANSI parser cannot handle.
            # Configure the ordinary comma in the isolated format definition; original files are untouched.
            config=directory/'Par.txt';data=config.read_bytes().decode('gb18030')
            data,count=re.subn(r'(平面逗号CSV[^\r\n]*[\r\n]+CSV[\r\n]+)[^\r\n]*',r'\g<1>,',data,count=1)
            if count!=1:raise RuntimeError('The legacy CSV format configuration differs from the tested version')
            config.write_bytes(data.encode('gb18030'))
        self.job = self.k.CreateJobObjectW(None, None)
        if not self.job: raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimit(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE
        if not self.k.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        info = StartupInfo(); info.cb = ctypes.sizeof(info); info.flags = 1; info.show = 0
        process = ProcessInfo(); executable = str(directory / 'COORD.exe')
        if not self.k.CreateProcessW(executable, ctypes.create_unicode_buffer('"' + executable + '"'), None, None, False,
                                     0x4 | 0x08000000, None, str(directory), ctypes.byref(info), ctypes.byref(process)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.process = process.process; self.pid = process.pid
        try:
            if not self.k.AssignProcessToJobObject(self.job, self.process):
                self.k.TerminateProcess(self.process, 1)
                raise ctypes.WinError(ctypes.get_last_error())
            if self.k.ResumeThread(process.thread) == 0xFFFFFFFF: raise ctypes.WinError(ctypes.get_last_error())
        finally: self.k.CloseHandle(process.thread)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            found = [h for h in self.windows() if self.class_name(h) == '#32770' and self.text(h).startswith('COORD GM')]
            if len(found) == 1:
                self.main = found[0]; self.u.ShowWindow(self.main, 0)
                self.control(1015, 'Button')
                return
            if self.k.WaitForSingleObject(self.process, 0) == 0: raise RuntimeError('COORD exited immediately after launch')
            time.sleep(.02)
        raise RuntimeError('The COORD main window was not found')

    def popup_error(self):
        if self.u.IsWindowEnabled(self.main): return None
        for h in self.windows():
            if h != self.main and self.class_name(h) == '#32770':
                self.u.ShowWindow(h, 0)
                labels = [self.text(c) for c in self.windows(h) if self.class_name(c) == 'Static']
                return '；'.join(t for t in labels if t) or '原 COORD 弹出了提示窗口'
        return '原 COORD 正在等待参数或输入确认'

    def select(self, cid, index):
        h = self.control(cid, 'ComboBox')
        self.send(h, 0x14E, index); self.send(self.main, 0x111, (1 << 16) | cid, h)
        error = self.popup_error()
        if error: raise RuntimeError(error)
        if self.send(h, 0x147) != index: raise RuntimeError('The COORD dropdown selection was not applied')

    def radio(self, cid):
        h = self.control(cid, 'Button'); self.send(h, 0xF5)
        error = self.popup_error()
        if error: raise RuntimeError(error)
        if self.send(h, 0xF0) != 1: raise RuntimeError('The COORD coordinate type was not applied')

    def set_text(self, cid, value, parent=None):
        h = self.control(cid, 'Edit', parent); buffer = ctypes.create_unicode_buffer(value)
        self.send(h, 0xC, 0, ctypes.addressof(buffer))
        if self.text(h) != value: raise RuntimeError('Original COORD Input  Write failed')

    def projection(self, params):
        if not self.u.PostMessageW(self.main, 0x111, 32771, 0): raise RuntimeError('Unable to open the legacy projection settings')
        deadline = time.monotonic() + 4
        dialog = None
        while time.monotonic() < deadline:
            found = [h for h in self.windows() if h != self.main and self.class_name(h) == '#32770' and self.text(h) == '投影设置']
            if len(found) == 1: dialog = found[0]; break
            time.sleep(.02)
        if dialog is None: raise RuntimeError('The COORD projection settings dialog was not found')
        self.modal = dialog; self.u.ShowWindow(dialog, 0)
        box = self.control(1132, 'ListBox', dialog)
        index = PROJECTION_MODES[params['mode']]
        buffer = ctypes.create_unicode_buffer(256); self.send(box, 0x189, index, ctypes.addressof(buffer))
        if buffer.value != PROJECTION_NAMES[index]: raise RuntimeError('The COORD projection types differ from the tested version')
        self.send(box, 0x186, index); self.send(dialog, 0x111, (1 << 16) | 1132, box)
        if self.send(box, 0x188) != index: raise RuntimeError('The COORD projection selection was not applied')
        fields = {'lon0':1059, 'k0':1060, 'x0':1019, 'y0':1020, 'lat0':1021, 'height':1022, 'meanLat':1023}
        for key, cid in fields.items():
            value = params[key]
            value = native_angle(value, key == 'lon0') if key in ('lon0','lat0','meanLat') else format(value, '.15g')
            control = self.control(cid, 'Edit', dialog)
            if self.u.IsWindowEnabled(control): self.set_text(cid, value, dialog)
        for cid in [1158 if params['north'] else 1159, 1160 if params['east'] else 1161]:
            control = self.control(cid, 'Button', dialog); self.send(control, 0xF5)
            if self.send(control, 0xF0) != 1: raise RuntimeError('Original COORD Projection  Positive direction  Settings  Failed')
        readback = {key:self.text(self.control(cid,'Edit',dialog)) for key,cid in fields.items()}
        button = self.control(1, 'Button', dialog)
        if self.text(button) != '确定': raise RuntimeError('The projection dialog confirmation button does not match')
        self.u.PostMessageW(button, 0xF5, 0, 0)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if not self.u.IsWindow(dialog): self.modal = None; break
            other = [h for h in self.windows() if h not in (self.main,dialog) and self.class_name(h)=='#32770']
            if other:
                self.u.ShowWindow(other[0],0)
                labels=[self.text(c) for c in self.windows(other[0]) if self.class_name(c)=='Static']
                raise ValueError('；'.join(t for t in labels if t) or 'Legacy projection settings failed validation')
            time.sleep(.02)
        else: raise RuntimeError('The projection dialog was not confirmed')
        if not self.u.IsWindowEnabled(self.main): raise RuntimeError('COORD is still waiting for projection parameters')
        return readback

    def configure(self, params, emit):
        self.start()
        emit({'type': 'progress', 'percent': 30, 'message': 'COORD is ready','nativeWorkDir':self.temp.name})
        for cid, ellipsoid in [(1011, params['sourceEllipsoid']), (1023, params['targetEllipsoid'])]:
            combo = self.control(cid, 'ComboBox')
            items = []
            for index in range(self.send(combo, 0x146)):
                buffer = ctypes.create_unicode_buffer(256); self.send(combo, 0x148, index, ctypes.addressof(buffer)); items.append(buffer.value)
            if items != EXPECTED_ELLIPSOIDS: raise RuntimeError('The COORD ellipsoid list differs from the tested version')
            self.select(cid, ELLIPSOIDS[ellipsoid])
        self.radio(SOURCE_IDS[params['sourceType']]); self.radio(TARGET_IDS[params['targetType']])
        self.select(1082, params['sourceFormat']); self.select(1083, params['targetFormat'])
        projection_readback = None
        if params['sourceType'] == 'xyh' or params['targetType'] == 'xyh':
            projection_readback = self.projection(params['projection'])
        if any(self.send(self.control(cid, 'Button'), 0xF0) for cid in [1007, 1009, 1138]):
            raise RuntimeError('Default COORD conversion switches differ from the tested state')
        return projection_readback

    def convert(self, params, emit):
        projection_readback = self.configure(params, emit)
        for cid, value in zip([1002, 1003, 1004], params['values']): self.set_text(cid, value)
        for cid in [1017, 1019, 1021]: self.set_text(cid, '')
        emit({'type': 'progress', 'percent': 65, 'message': 'Running legacy conversion'})
        self.send(self.control(1015, 'Button'), 0xF5)
        error = self.popup_error()
        if error: raise ValueError(error)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            values = [self.text(self.control(cid, 'Edit')) for cid in [1017, 1019, 1021]]
            if all(values):
                return {'engine': 'COORD GM', 'values': values, 'inputReadback': [self.text(self.control(cid, 'Edit')) for cid in [1002,1003,1004]],
                        'sourceType': params['sourceType'], 'targetType': params['targetType'],
                        'projectionReadback': projection_readback,
                        'nativeWindowHidden': not bool(self.u.IsWindowVisible(self.main)), 'nativePid': self.pid}
            time.sleep(.05)
        raise RuntimeError('COORD did not return a complete result')

    def dialog(self, title, timeout=4):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            found=[h for h in self.windows() if h!=self.main and self.class_name(h)=='#32770' and self.text(h)==title]
            if len(found)==1:
                self.modal=found[0];self.u.ShowWindow(self.modal,0);return self.modal
            time.sleep(.02)
        raise RuntimeError('Legacy COORD dialog not found:'+title+' dialog')

    def confirm_dialog(self, dialog):
        button=self.control(1,'Button',dialog)
        self.u.PostMessageW(button,0xF5,0,0)
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            if not self.u.IsWindow(dialog):self.modal=None;return
            others=[h for h in self.windows() if h not in (self.main,dialog) and self.class_name(h)=='#32770']
            if others:
                self.u.ShowWindow(others[0],0)
                labels=[self.text(c) for c in self.windows(others[0]) if self.class_name(c)=='Static']
                raise ValueError('；'.join(t for t in labels if t) or 'Legacy file settings failed validation')
            time.sleep(.02)
        raise RuntimeError('The COORD dialog was not confirmed')

    def file_format(self, index, naming, merge):
        tab=self.control(1032,'SysTabControl32')
        self.send(tab,0x1330,1);self.send(tab,0x100,0x20,1);self.send(tab,0x101,0x20,1)
        if self.send(tab,0x130B)!=1:raise RuntimeError('Unable to switch to legacy file conversion')
        self.u.PostMessageW(self.control(1034,'Button'),0xF5,0,0)
        dialog=self.dialog('文件格式');box=self.control(1043,'ListBox',dialog)
        buffer=ctypes.create_unicode_buffer(512);self.send(box,0x189,index,ctypes.addressof(buffer))
        if buffer.value!=FILE_FORMATS[index][0]:raise RuntimeError('The COORD file format list differs from the tested version')
        self.send(box,0x186,index);self.send(dialog,0x111,(1<<16)|1043,box)
        naming_id={'extension':1024,'stem':1027,'same':1061}[naming]
        # Hidden legacy radio mouse handlers can block; its OK handler reads these standard check states.
        for cid in [1024,1027,1061]:self.send(self.control(cid,'Button',dialog),0xF1,int(cid==naming_id))
        radio=self.control(naming_id,'Button',dialog)
        if self.send(radio,0xF0)!=1:raise RuntimeError('Unable to set legacy output naming')
        checkbox=self.control(1084,'Button',dialog)
        self.send(checkbox,0xF1,int(merge))
        self.send(dialog,0x111,1084,checkbox)
        if bool(self.send(checkbox,0xF0))!=merge:raise RuntimeError('Unable to set the legacy merge option')
        self.confirm_dialog(dialog)
        if not self.u.IsWindowEnabled(self.control(1033,'Button')):raise RuntimeError('The legacy file format settings were not applied')

    def batch_file(self, staged, naming):
        self.u.PostMessageW(self.control(1033,'Button'),0xF5,0,0)
        dialog=self.dialog('选择源文件')
        self.set_text(1152,staged.name,dialog)
        self.confirm_dialog(dialog)
        box=self.control(1037,'ListBox')
        count=self.send(box,0x18B)
        if count<1:raise RuntimeError('The COORD source file list is empty')
        self.send(box,0x186,count-1);self.send(self.main,0x111,(1<<16)|1037,box)
        self.u.PostMessageW(self.control(1039,'Button'),0xF5,0,0)
        confirmed=False;deadline=time.monotonic()+25
        expected=Path(str(staged)+'1') if naming=='extension' else staged.with_name(staged.stem+'1'+staged.suffix) if naming=='stem' else staged
        while time.monotonic()<deadline:
            dialogs=[h for h in self.windows() if h!=self.main and self.class_name(h)=='#32770']
            for current in dialogs:
                self.u.ShowWindow(current,0)
                texts=[self.text(c) for c in self.windows(current) if self.class_name(c)=='Static']
                message='；'.join(t for t in texts if t)
                if message=='请确定已经设置转换关系了!' and not confirmed:
                    button=self.control(1,'Button',current)
                    if self.text(button)!='确定':raise RuntimeError('The legacy conversion confirmation button does not match')
                    self.u.PostMessageW(button,0xF5,0,0);confirmed=True
                elif message and message!='请确定已经设置转换关系了!':raise ValueError(message)
            if confirmed and self.u.IsWindowEnabled(self.main):
                output=self.control(1038,'ListBox')
                if self.send(output,0x18B)>0 and expected.is_file():return expected
            time.sleep(.025)
        raise RuntimeError('COORD did not finish file conversion')

    def close(self):
        # Only the isolated computation process is terminated; the user's COORD is untouched.
        if self.job: self.k.CloseHandle(self.job); self.job = None
        if self.process:
            self.k.WaitForSingleObject(self.process, 4000); self.k.CloseHandle(self.process); self.process = None
        if self.temp:
            try: self.temp.cleanup()
            except OSError: pass  # Interrupted jobs can leave disposable temp files.
            self.temp = None


def native_angle(value, longitude=False):
    # Only an input-format conversion; coordinate math remains in original COORD.
    suffix = ('E' if value >= 0 else 'W') if longitude else ('N' if value >= 0 else 'S')
    seconds = round(abs(value)*3600, 6)
    degrees = int(seconds//3600); minutes = int((seconds-degrees*3600)//60); seconds -= degrees*3600+minutes*60
    return f'{degrees:03d}:{minutes:02d}:{seconds:09.6f}{suffix}'


def projection_params(value):
    if not isinstance(value, dict): raise ValueError('Projected coordinates require map projection parameters')
    mode = value.get('mode', 'gauss3')
    if mode not in PROJECTION_MODES: raise ValueError('Unsupported projection type')
    defaults={'lon0':114,'k0':.9996 if mode=='utm' else 1,'x0':0,'y0':500000,'lat0':0,'height':0,'meanLat':0}
    result={'mode':mode}
    for key, default in defaults.items():
        raw=value.get(key,default)
        if isinstance(raw,bool): raise ValueError('Projection parameters must be numeric')
        try: number=float(raw)
        except (TypeError,ValueError): raise ValueError('Projection parameters must be numeric') from None
        if not math.isfinite(number): raise ValueError('Projection parameters must be finite')
        result[key]=number
    if not -180<=result['lon0']<=180: raise ValueError('The central meridian must be between -180 and 180 degrees')
    if not -90<result['meanLat']<90 or result['lat0']!=0: raise ValueError('Invalid mean latitude; the current Gauss/UTM latitude of origin is zero')
    if not 0<result['k0']<=10: raise ValueError('Projection scale must be greater than zero and at most 10')
    if mode!='utm' and result['k0']!=1: raise ValueError('Legacy Gauss projection uses scale 1; use UTM for adjustable scale')
    if mode in ('gauss3','gauss6') and any(result[k]!=defaults[k] for k in ('x0','y0','height','meanLat')):
        raise ValueError('Three- and six-degree zones use fixed offsets; choose custom Gauss to change offsets or projection-plane elevation')
    if mode=='utm' and result['height']!=0: raise ValueError('Legacy UTM does not support projection-plane elevation')
    for key in ['north','east']:
        if type(value.get(key,True)) is not bool: raise ValueError('Invalid coordinate positive direction')
        result[key]=value.get(key,True)
    return result


def normalize_settings(params):
    if not isinstance(params, dict): raise ValueError('Request parameters must be an object')
    source_type, target_type = params.get('sourceType'), params.get('targetType')
    if source_type not in SOURCE_IDS or target_type not in TARGET_IDS:
        raise ValueError('Unknown coordinate type')
    source_ellipsoid, target_ellipsoid = params.get('sourceEllipsoid'), params.get('targetEllipsoid')
    if source_ellipsoid not in ELLIPSOIDS or target_ellipsoid not in ELLIPSOIDS: raise ValueError('Unknown ellipsoid')
    if source_ellipsoid != target_ellipsoid: raise ValueError('Local cross-datum parameters are not connected; configure and calculate in COORD')
    normalized = dict(params)
    if source_type == 'xyh' or target_type == 'xyh': normalized['projection']=projection_params(params.get('projection'))
    for key in ['sourceFormat', 'targetFormat']:
        value = params.get(key, 0)
        if type(value) is not int or not 0 <= value <= 7: raise ValueError('Unknown angle format')
        normalized[key] = value
    return normalized


def convert(params, emit):
    normalized=normalize_settings(params)
    source_type=normalized['sourceType']
    values = normalized.get('values')
    if not isinstance(values, list) or len(values) != 3 or any(not isinstance(v, str) or not v.strip() or len(v) > 100 for v in values):
        raise ValueError('Enter three coordinate values, each no longer than 100 characters')
    for value in (values if source_type in ('xyz','xyh') else values[2:]):
        try:
            if not math.isfinite(float(value)): raise ValueError()
        except ValueError: raise ValueError('Cartesian coordinates and height must be finite numbers') from None
    session = CoordSession()
    try: return session.convert(normalized, emit)
    finally: session.close()


def preview_bytes(data):
    try:return codecs.getincrementaldecoder('utf-8-sig')().decode(data,final=False)
    except UnicodeDecodeError:return data.decode('gb18030',errors='replace')


def export_unique(source, directory, name):
    # Windows rename commits a finished file atomically and rejects an existing destination.
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(dir=directory,prefix='.coord-',suffix='.partial',delete=False) as output:
            temporary=Path(output.name)
            with source.open('rb') as input_file:shutil.copyfileobj(input_file,output)
        for index in range(10000):
            candidate=directory/name if index==0 else directory/(Path(name).stem+'_'+str(index)+Path(name).suffix)
            try:temporary.rename(candidate);return candidate
            except FileExistsError:continue
        raise RuntimeError('Too many output files with the same name')
    finally:
        if temporary:temporary.unlink(missing_ok=True)


def batch(params,emit):
    settings=normalize_settings(params)
    index=params.get('fileFormat',3)
    if type(index) is not int or not 0<=index<len(FILE_FORMATS):raise ValueError('Unknown legacy file format')
    family=FILE_FORMATS[index][2]
    if (family=='blh')!=(settings['sourceType']=='blh'):raise ValueError('Legacy file format does not match the source coordinate type')
    naming=params.get('naming','extension')
    if naming not in ('extension','stem','same'):raise ValueError('Unknown output naming method')
    merge=params.get('merge',False)
    if type(merge) is not bool:raise ValueError('Invalid merge option')
    if merge:raise ValueError('Merged input/output format is not connected; use COORD directly')
    paths=params.get('files')
    if not isinstance(paths,list) or not 1<=len(paths)<=20 or any(not isinstance(p,str) for p in paths):raise ValueError('Select 1 to 20 source files per operation')
    sources=[Path(p).resolve(strict=True) for p in paths]
    if any(not p.is_file() or p.stat().st_size>10*1024*1024 for p in sources):raise ValueError('Source files must be regular files of at most 10 MB each')
    if sum(p.stat().st_size for p in sources)>50*1024*1024:raise ValueError('Total batch size must not exceed 50 MB')
    directory=Path(params.get('outputDir',''))
    if not directory.is_absolute() or not directory.is_dir():raise ValueError('Select an existing output folder')
    directory=directory.resolve(strict=True)
    session=CoordSession(file_format=index);results=[];errors=[]
    try:
        session.configure(settings,emit)
        session.file_format(index,naming,merge)
        for number,source in enumerate(sources,1):
            if number>1:
                session.close();session=CoordSession(file_format=index)
                session.configure(settings,lambda event:emit(dict(event,percent=30+int(65*(number-1)/len(sources)))));session.file_format(index,naming,merge)
            emit({'type':'progress','percent':30+int(65*(number-1)/len(sources)),'message':f'原 COORD 正在转换 {source.name}（{number}/{len(sources)}）'})
            # This legacy common-file dialog hangs on long leaf names. Work copies use 8.3 names.
            staged=Path(session.temp.name)/'COORD'/('SW'+str(number).zfill(4)+'.'+FILE_FORMATS[index][1])
            shutil.copyfile(source,staged)
            try:
                generated=session.batch_file(staged,naming)
                name=source.name+'1' if naming=='extension' else source.stem+'1'+source.suffix if naming=='stem' else source.name
                exported=export_unique(generated,directory,name)
                with exported.open('rb') as stream:preview=preview_bytes(stream.read(8192))
                results.append({'inputPath':str(source),'outputPath':str(exported),'name':exported.name,'bytes':exported.stat().st_size,'preview':preview})
            except Exception as exc:
                errors.append({'name':source.name,'error':str(exc)})
                break  # Failed native state may include a modal; do not reuse it.
        return {'engine':'COORD GM file converter','results':results,'errors':errors,'requested':len(sources),'completed':len(results),
                'outputDir':str(directory),'nativePid':session.pid,'nativeWindowHidden':not bool(session.u.IsWindowVisible(session.main))}
    finally:session.close()


def cleanup_copies(directories):
    """Remove only exact private executables, including legacy shell-launched peers outside our Job."""
    root=Path(tempfile.gettempdir()).resolve()
    owned=[]
    for value in directories:
        directory=Path(value).resolve()
        if directory.parent!=root or not directory.name.startswith('shanwei-coord-'):
            raise ValueError("Only this application's own working copy may be cleaned up")
        owned.append(directory)
    expected={str(directory/'COORD'/'COORD.exe').casefold() for directory in owned}
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    class Entry(ctypes.Structure):
        _fields_=[('size',w.DWORD),('usage',w.DWORD),('pid',w.DWORD),('heap',ctypes.c_size_t),('module',w.DWORD),
                  ('threads',w.DWORD),('parent',w.DWORD),('priority',w.LONG),('flags',w.DWORD),('exe',w.WCHAR*260)]
    signatures={
        'CreateToolhelp32Snapshot':([w.DWORD,w.DWORD],w.HANDLE),
        'Process32FirstW':([w.HANDLE,ctypes.POINTER(Entry)],w.BOOL),
        'Process32NextW':([w.HANDLE,ctypes.POINTER(Entry)],w.BOOL),
        'OpenProcess':([w.DWORD,w.BOOL,w.DWORD],w.HANDLE),
        'QueryFullProcessImageNameW':([w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)],w.BOOL),
        'TerminateProcess':([w.HANDLE,w.UINT],w.BOOL),'WaitForSingleObject':([w.HANDLE,w.DWORD],w.DWORD),
        'CloseHandle':([w.HANDLE],w.BOOL)
    }
    for name,(args,result) in signatures.items():getattr(k,name).argtypes=args;getattr(k,name).restype=result
    killed=[]
    for _ in range(2):
        snapshot=k.CreateToolhelp32Snapshot(2,0)
        if snapshot==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry=Entry();entry.size=ctypes.sizeof(entry);available=k.Process32FirstW(snapshot,ctypes.byref(entry))
            while available:
                if entry.exe.casefold()=='coord.exe':
                    process=k.OpenProcess(0x1000|0x1|0x100000,False,entry.pid)
                    if process:
                        try:
                            buffer=ctypes.create_unicode_buffer(32768);length=w.DWORD(len(buffer))
                            if k.QueryFullProcessImageNameW(process,0,buffer,ctypes.byref(length)) and buffer.value.casefold() in expected:
                                if not k.TerminateProcess(process,0):raise ctypes.WinError(ctypes.get_last_error())
                                if k.WaitForSingleObject(process,1500)!=0:raise RuntimeError('The temporary COORD process has not exited')
                                killed.append(entry.pid)
                        finally:k.CloseHandle(process)
                available=k.Process32NextW(snapshot,ctypes.byref(entry))
        finally:k.CloseHandle(snapshot)
        time.sleep(.1)
    for directory in owned:
        # Resolved exact temporary targets above are verified before recursive removal.
        if directory.exists():shutil.rmtree(directory,ignore_errors=True)
    return killed
