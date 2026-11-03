"""Local geometry parsing. JSON contains metadata only; geometry stays binary."""
from pathlib import Path
from array import array
import hashlib,json,math,os,re,sys,time
VERSION='geometry-v1'
def parse_geometry(path,str_path=None):
 path=Path(path);kind=path.suffix.lower();vertices=[];indices=[];ids={};name=path.stem;coord=None;origin_points=[]
 def add(x,y,z):
  if not all(math.isfinite(v) for v in (x,y,z)):raise ValueError('The model contains non-finite coordinates')
  vertices.extend((x,z,-y));origin_points.append((x,y,z))
 if kind=='.ts':
  in_header=False;in_coord=False;coord_lines=[]
  name='unnamed'
  for raw in path.open(encoding='utf-8-sig',errors='replace'):
   line=raw.strip();s=line.split()
   if line.startswith('HEADER'):in_header=True;continue
   if in_header:
    if line=='}':in_header=False
    elif re.match(r'name\s*:',line,re.I):name=line.split(':',1)[1].strip()
    continue
   if line.startswith(('GOCAD_ORIGINAL_COORDINATE_SYSTEM','GOCAD_COORDINATE_SYSTEM')):in_coord=True;continue
   if in_coord:
    if line.startswith(('END_ORIGINAL_COORDINATE_SYSTEM','END_COORDINATE_SYSTEM')):in_coord=False;coord=' '.join(coord_lines).strip()
    else:coord_lines.append(line)
    continue
   if not s:continue
   if s[0] in ('VRTX','PVRTX'):
    try:ident=int(s[1]);p=tuple(map(float,s[2:5]));assert len(p)==3
    except (ValueError,IndexError,AssertionError):continue
    if not all(math.isfinite(v) for v in p):continue
    origin_points.append(p) if ident in ids else None
    if ident not in ids:ids[ident]=len(vertices)//3;add(*p)
   elif s[0]=='ATOM' and len(s)>2:
    if int(s[2]) in ids:ids[int(s[1])]=ids[int(s[2])]
   elif s[0] in ('TRGL','TRI') and len(s)>3:
    refs=list(map(int,s[1:4]))
    if all(i in ids for i in refs):indices.extend(ids[i] for i in refs)
 elif kind=='.obj':
  name=re.sub(r'\.[^.]+$', '', path.stem)
  named=False
  for raw in path.open(encoding='utf-8-sig',errors='replace'):
   s=raw.strip().split()
   if not s or s[0].startswith('#'):continue
   if s[0]=='v' and len(s)>=4:add(*map(float,s[1:4]))
   elif s[0] in ('o','g') and len(s)>1 and not named:name=s[1];named=True
   elif s[0]=='f' and len(s)>=4:
    refs=[]
    for item in s[1:]:
     if item.startswith('#'):break
     n=int(item.split('/')[0]);refs.append(len(vertices)//3+n if n<0 else n-1)
    for i in range(1,len(refs)-1):indices.extend((refs[0],refs[i],refs[i+1]))
 elif kind=='.dtm':
  if not str_path:raise ValueError('The tunnel model requires an accompanying STR file')
  dtm=path.read_text(encoding='utf-8-sig',errors='replace');m=re.search(r'^POINTS\s+(\d+)',dtm,re.M|re.I);limit=int(m[1]) if m else None
  for raw in Path(str_path).open(encoding='utf-8-sig',errors='replace'):
   s=[a.strip() for a in raw.strip().split(',')]
   if len(s)<4:continue
   try:p=tuple(map(float,s[1:4]))
   except ValueError:continue
   if s[0]=='0' and p==(0.,0.,0.):continue
   if limit and len(vertices)//3>=limit:break
   add(*p)
  for raw in dtm.splitlines():
   s=raw.split(',')
   if len(s)<4:continue
   try:refs=[int(a.strip()) for a in s[1:4]]
   except ValueError:continue
   if min(refs)>0:indices.extend(i-1 for i in refs)
 else:raise ValueError('Only TS, OBJ, and DTM/STR are supported')
 if not vertices or not indices:raise ValueError('The model contains no valid vertices or triangles')
 if min(indices)<0 or max(indices)>=len(vertices)//3:raise ValueError('A model triangle index is out of bounds')
 verts=array('f',vertices);inds=array('I',indices)
 # Keep the original Float32 coordinates and the bounding box as they are, so that the existing display precision is unchanged.
 bounds_source=verts if kind=='.obj' else vertices
 bounds=[min(bounds_source[i::3]) for i in range(3)]+[max(bounds_source[i::3]) for i in range(3)]
 if kind=='.obj':origin=dict(zip(('x','y','z'),(math.floor(bounds[i]/100)*100 for i in range(3))))
 else:origin=dict(zip(('x','y','z'),(math.floor(min(p[i] for p in origin_points)/100)*100 for i in range(3))))
 if sys.byteorder!='little':verts.byteswap();inds.byteswap()
 meta={'name':name,'vertexCount':len(vertices)//3,'triangleCount':len(indices)//3,'boundingBox':bounds,'fileOrigin':origin,'origin':None}
 if coord:meta['coordinateSystem']=coord
 return meta,verts.tobytes(),inds.tobytes()
def run(params,send):
 start=time.perf_counter();p=Path(params['filePath']).resolve();sp=Path(params['strFilePath']).resolve() if params.get('strFilePath') else None
 sources=[p]+([sp] if sp else [])
 for f in sources:
  if not f.is_file():raise ValueError('Model source file does not exist:'+str(f))
 fingerprint=[(str(f),f.stat().st_size,f.stat().st_mtime_ns) for f in sources]
 key=hashlib.sha256(json.dumps([VERSION,fingerprint]).encode()).hexdigest();out=Path(params['outputDir']);out.mkdir(parents=True,exist_ok=True)
 target=out/(key+'.json');vb=out/(key+'.vertices.bin');ib=out/(key+'.indices.bin')
 if target.exists() and vb.exists() and ib.exists():
  meta=json.loads(target.read_text(encoding='utf-8'));hit=True
 else:
  send({'type':'progress','percent':10,'message':'Local parsing:'+p.name})
  meta,v,i=parse_geometry(p,sp);hit=False
  # The metadata is committed last, so that a half-finished result left behind by an interruption cannot hit the cache.
  for f,data in [(vb,v),(ib,i)]:
   temp=f.with_suffix(f.suffix+'.tmp');temp.write_bytes(data);os.replace(temp,f)
  temp=target.with_suffix('.json.tmp');temp.write_text(json.dumps(meta,ensure_ascii=False),encoding='utf-8');os.replace(temp,target)
 send({'type':'progress','percent':100,'message':'Model parsing complete'})
 return {'key':key,'metadata':meta,'cacheHit':hit,'elapsedMs':round((time.perf_counter()-start)*1000)}
