"""ASC parsing: retain Float64 coordinates and edge-connected zero mask."""
from pathlib import Path
from array import array
from collections import deque
import math,json,hashlib,os,sys,time
VERSION='terrain-v1'
def parse(path):
 keys={'ncols','nrows','xllcorner','yllcorner','xllcenter','yllcenter','cellsize','nodata_value'}
 def tokens():
  for line in Path(path).open(encoding='utf-8-sig',errors='replace'):
   yield from line.split()
 iterator=iter(tokens());header={};token=next(iterator,None)
 while token and token.lower() in keys:
  key=token.lower()
  if key in header:raise ValueError('Duplicate ASC header:'+key)
  try:value=float(next(iterator))
  except (StopIteration,ValueError):raise ValueError('Invalid ASC header value:'+key)
  if not math.isfinite(value):raise ValueError('Invalid ASC header value:'+key)
  header[key]=value;token=next(iterator,None)
 cols=header.get('ncols',0);rows=header.get('nrows',0);step=header.get('cellsize',0)
 if cols!=int(cols) or rows!=int(rows) or min(cols,rows)<2 or step<=0:raise ValueError('ASC requires valid dimensions and cell size')
 cols=int(cols);rows=int(rows)
 if cols*rows>1000000:raise ValueError('At most 1,000,000 elevation cells are supported')
 if ('xllcorner' in header)==('xllcenter' in header) or ('yllcorner' in header)==('yllcenter' in header):raise ValueError('ASC must specify exactly one lower-left corner or center origin')
 x0=header['xllcenter'] if 'xllcenter' in header else header['xllcorner']+step/2;y0=header['yllcenter'] if 'yllcenter' in header else header['yllcorner']+step/2
 ids=array('i',[-1])*cols*rows;values=array('d');vertices=array('d');indices=array('I');low=math.inf;high=-math.inf
 for cell in range(cols*rows):
  if token is None:raise ValueError('ASC elevation count does not match grid dimensions')
  try:z=float(token)
  except ValueError:raise ValueError('ASC contains invalid elevation values')
  if not math.isfinite(z):raise ValueError('ASC contains invalid elevation values')
  if z!=header.get('nodata_value'):
   ids[cell]=len(values);values.append(z);low=min(low,z);high=max(high,z);r,c=divmod(cell,cols);vertices.extend((x0+c*step,z,-(y0+(rows-1-r)*step)))
  token=next(iterator,None)
 if token is not None:raise ValueError('ASC elevation count does not match grid dimensions')
 for r in range(rows-1):
  for c in range(cols-1):
   a=ids[r*cols+c];b=ids[r*cols+c+1];d=ids[(r+1)*cols+c];e=ids[(r+1)*cols+c+1]
   if min(a,d,b)>=0:indices.extend((a,d,b))
   if min(b,d,e)>=0:indices.extend((b,d,e))
 if not indices:raise ValueError('ASC has no valid elevation grid from which to construct a surface')
 visited=bytearray(cols*rows);queue=[]
 def seed(r,c):
  cell=r*cols+c;ident=ids[cell]
  if not visited[cell] and ident>=0 and values[ident]==0:visited[cell]=1;queue.append(cell)
 for c in range(cols):seed(0,c);seed(rows-1,c)
 for r in range(rows):seed(r,0);seed(r,cols-1)
 i=0
 while i<len(queue):
  r,c=divmod(queue[i],cols);i+=1
  if r:seed(r-1,c)
  if r<rows-1:seed(r+1,c)
  if c:seed(r,c-1)
  if c<cols-1:seed(r,c+1)
 edges=array('I',(ids[cell] for cell in queue))
 meta={'name':Path(path).name,'vertexType':'float64','vertexCount':len(values),'triangleCount':len(indices)//3,'boundaryZeroCount':len(edges),'boundingBox':[x0,y0,low,x0+(cols-1)*step,y0+(rows-1)*step,high],'fileOrigin':{'x':x0+(cols-1)*step/2,'y':y0+(rows-1)*step/2,'z':(low+high)/2},'terrainInfo':{'cols':cols,'rows':rows,'cellsize':step,'validCells':len(values),'minHeight':low,'maxHeight':high,'boundaryZeroCount':len(queue)},'source':{'fileName':Path(path).name}}
 return meta,vertices,indices,edges
def run(params,send):
 start=time.perf_counter();p=Path(params['filePath']).resolve();st=p.stat()
 if st.st_size>100*1024*1024:raise ValueError('ASC file exceeds 100 MB')
 key=hashlib.sha256(json.dumps([VERSION,str(p),st.st_size,st.st_mtime_ns]).encode()).hexdigest();out=Path(params['outputDir']);out.mkdir(parents=True,exist_ok=True);mp=out/(key+'.json')
 paths=[out/(key+'.'+kind+'.bin') for kind in ['vertices','indices','edges']];hit=mp.exists() and all(p.exists() for p in paths)
 if hit:meta=json.loads(mp.read_text(encoding='utf-8'))
 else:
  send({'type':'progress','percent':10,'message':'Parsing ASC grid and boundary zeros'})
  meta,*buffers=parse(p)
  for target,data in zip(paths,buffers):
   if sys.byteorder!='little':data.byteswap()
   temp=target.with_suffix('.bin.tmp')
   with temp.open('wb') as f:data.tofile(f)
   os.replace(temp,target)
  temp=mp.with_suffix('.json.tmp');temp.write_text(json.dumps(meta,ensure_ascii=False),encoding='utf-8');os.replace(temp,mp)
 return {'key':key,'metadata':meta,'cacheHit':hit,'elapsedMs':round((time.perf_counter()-start)*1000)}
