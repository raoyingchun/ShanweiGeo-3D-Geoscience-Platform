"""CSV block preparation with binary instance matrices and picking bounds."""
from pathlib import Path
from array import array
import csv,hashlib,json,math,os,sys,time
VERSION='blocks-v1'
def prepare(path,existing_origin=None,send=lambda event:None):
 def rows():
  with Path(path).open(encoding='utf-8-sig',errors='replace',newline='') as f:
   reader=csv.reader(f);first=next(reader,[]);header=[v.strip().upper() for v in first];has_header=all(v in header for v in ['X','Y','Z'])
   indexes=[header.index(v) if has_header and v in header else i+1 for i,v in enumerate(['X','Y','Z','DX','DY','DZ','GM'])]
   def row(p):
    if len(p)<8:return None
    try:
     nums=[float(p[i].strip() or '0') for i in indexes[:6]];gm=p[indexes[6]].strip()
     if gm and all(math.isfinite(v) for v in nums):return nums,gm
    except (ValueError,IndexError):pass
   if not has_header:
    value=row(first)
    if value:yield value
   for p in reader:
    value=row(p)
    if value:yield value
 counts={};minimum=[math.inf]*3;total=0
 for values,gm in rows():
  counts[gm]=counts.get(gm,0)+1;total+=1
  for i in range(3):minimum[i]=min(minimum[i],values[i])
  if total%100000==0:send({'type':'progress','percent':15,'message':f'统计块体：{total}'})
 if not total:raise ValueError('No valid blocks found; check coordinates, dimensions, and the GM column')
 origin=existing_origin or dict(zip(('x','y','z'),[math.floor(v/100)*100 for v in minimum]))
 if not all(math.isfinite(origin[k]) for k in ('x','y','z')):raise ValueError('Invalid block origin')
 groups=[];by_name={};matrix_offset=chunk_offset=0
 for gm,count in counts.items():
  g={'name':gm,'count':count,'bounds':[math.inf]*3+[-math.inf]*3,'matrixOffset':matrix_offset,'chunkOffset':chunk_offset,'chunkLength':math.ceil(count/128)*6,'used':0,'matrices':array('f',[0])*count*16,'chunks':array('d',[math.inf]*3+[-math.inf]*3)*math.ceil(count/128)}
  groups.append(g);by_name[gm]=g;matrix_offset+=count*16;chunk_offset+=g['chunkLength']
 for done,(v,gm) in enumerate(rows(),1):
  x,y,z,dx,dy,dz=v;g=by_name[gm];i=g['used'];g['used']+=1;o=i*16;m=g['matrices'];m[o]=dx or 10;m[o+5]=dz or 10;m[o+10]=dy or 10;m[o+15]=1;m[o+12]=x-origin['x'];m[o+13]=z-origin['z'];m[o+14]=origin['y']-y
  chunk=(i//128)*6
  for axis in range(3):
   lo=m[o+12+axis]-abs(m[o+axis*5])/2;hi=m[o+12+axis]+abs(m[o+axis*5])/2
   g['bounds'][axis]=min(g['bounds'][axis],lo);g['bounds'][axis+3]=max(g['bounds'][axis+3],hi)
   g['chunks'][chunk+axis]=min(g['chunks'][chunk+axis],lo);g['chunks'][chunk+axis+3]=max(g['chunks'][chunk+axis+3],hi)
  if done%100000==0:send({'type':'progress','percent':20+round(done/total*65),'message':f'生成实例：{done}/{total}'})
 return {'origin':origin,'total':total,'groups':groups}
def run(params,send):
 start=time.perf_counter();p=Path(params['filePath']).resolve();st=p.stat()
 key=hashlib.sha256(json.dumps([VERSION,str(p),st.st_size,st.st_mtime_ns,params.get('origin')],sort_keys=True).encode()).hexdigest()
 out=Path(params['outputDir']);out.mkdir(parents=True,exist_ok=True);meta_path=out/(key+'.json');mp=out/(key+'.matrices.bin');cp=out/(key+'.chunks.bin')
 hit=meta_path.exists() and mp.exists() and cp.exists()
 if hit:meta=json.loads(meta_path.read_text(encoding='utf-8'))
 else:
  prepared=prepare(p,params.get('origin'),send);meta={'origin':prepared['origin'],'total':prepared['total'],'groups':[]}
  with mp.with_suffix('.bin.tmp').open('wb') as mf,cp.with_suffix('.bin.tmp').open('wb') as cf:
   for g in prepared['groups']:
    if sys.byteorder!='little':g['matrices'].byteswap();g['chunks'].byteswap()
    g['matrices'].tofile(mf);g['chunks'].tofile(cf)
    meta['groups'].append({k:v for k,v in g.items() if k not in ('used','matrices','chunks')})
  os.replace(mp.with_suffix('.bin.tmp'),mp);os.replace(cp.with_suffix('.bin.tmp'),cp)
  temp=meta_path.with_suffix('.json.tmp');temp.write_text(json.dumps(meta,ensure_ascii=False),encoding='utf-8');os.replace(temp,meta_path)
 return {'key':key,'metadata':meta,'cacheHit':hit,'elapsedMs':round((time.perf_counter()-start)*1000)}
