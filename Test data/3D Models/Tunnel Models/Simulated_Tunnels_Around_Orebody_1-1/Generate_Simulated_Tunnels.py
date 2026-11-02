from pathlib import Path
import math,json
ROOT=Path(__file__).resolve().parent
source=ROOT.parent.parent/'Geological Models'/'ljx_2 - 1-1.ts'
vs={};tris=[]
for line in source.read_text().splitlines():
 s=line.split()
 if s and s[0] in ('VRTX','PVRTX'):vs[int(s[1])]=tuple(map(float,s[2:5]))
 elif s and s[0]=='TRGL':tris.append(tuple(map(int,s[1:4])))
def hull(points):
 p=sorted(set(points))
 def cross(o,a,b):return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
 lower=[];upper=[]
 for a in p:
  while len(lower)>1 and cross(lower[-2],lower[-1],a)<=0:lower.pop()
  lower.append(a)
 for a in reversed(p):
  while len(upper)>1 and cross(upper[-2],upper[-1],a)<=0:upper.pop()
  upper.append(a)
 return lower[:-1]+upper[:-1]
def offset(p,d):
 lines=[]
 for a,b in zip(p,p[1:]+p[:1]):
  dx,dy=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dy);nx,ny=dy/length,-dx/length
  lines.append((a[0]+nx*d,a[1]+ny*d,dx,dy))
 out=[]
 for i,l in enumerate(lines):
  x,y,dx,dy=lines[i-1];u,v,ex,ey=l;det=dx*ey-dy*ex
  t=((u-x)*ey-(v-y)*ex)/det
  out.append((x+t*dx,y+t*dy))
 return out
vertices=[];faces=[];paths=[]
def tube(points,r=2,closed=False):
 # 4米宽、4米高的圆拱近似断面；平面巷道采用水平横向和竖直方向。
 start=len(vertices);n=8
 for i,p in enumerate(points):
  prev=points[(i-1)%len(points)] if closed or i else points[i]
  nxt=points[(i+1)%len(points)] if closed or i<len(points)-1 else points[i]
  dx,dy,dz=[nxt[k]-prev[k] for k in range(3)];length=math.hypot(dx,dy)
  if length<1e-8:side=(1,0,0);up=(0,1,0)
  else:side=(-dy/length,dx/length,0);up=(0,0,1)
  for j in range(n):
   a=2*math.pi*j/n
   vertices.append(tuple(p[k]+r*(math.cos(a)*side[k]+math.sin(a)*up[k]) for k in range(3)))
 for i in range(len(points) if closed else len(points)-1):
  k=(i+1)%len(points)
  for j in range(n):
   a=start+i*n+j;b=start+i*n+(j+1)%n;c=start+k*n+(j+1)%n;d=start+k*n+j
   faces.extend([(a,b,c),(a,c,d)])
 if not closed:
  for j in range(1,n-1):faces.extend([(start,start+j+1,start+j),(start+(len(points)-1)*n,start+(len(points)-1)*n+j,start+(len(points)-1)*n+j+1)])
levels=[-250,-100,50,200,350];sx=max(p[0] for p in vs.values())+120;sy=max(p[1] for p in vs.values())+120
for z in levels:
 hits=[]
 for tri in tris:
  p=[vs[v] for v in tri]
  for a,b in zip(p,p[1:]+p[:1]):
   if (a[2]<=z<b[2]) or (b[2]<=z<a[2]):
    t=(z-a[2])/(b[2]-a[2]);hits.append((a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])))
 polygon=offset(hull(hits),40)
 points=[]
 for a,b in zip(polygon,polygon[1:]+polygon[:1]):
  count=max(1,math.ceil(math.dist(a,b)/10))
  points.extend([(a[0]+(b[0]-a[0])*i/count,a[1]+(b[1]-a[1])*i/count,z) for i in range(count)])
 tube(points,closed=True);paths.append({'name':f'环绕中段_{z}m','closed':True,'points':points})
 a=max(points,key=lambda p:p[0]+p[1]);b=(sx,sy,z);count=math.ceil(math.dist(a,b)/10)
 branch=[tuple(a[k]+(b[k]-a[k])*i/count for k in range(3)) for i in range(count+1)]
 tube(branch);paths.append({'name':f'联络巷_{z}m','closed':False,'points':branch})
shaft=[(sx,sy,z) for z in range(-250,351,10)];tube(shaft,r=3);paths.append({'name':'联络竖井','closed':False,'points':shaft})
name='simulated_1_1_surrounding_tunnels'
header=f'{name},13-Oct-26,SIMULATED NOT SURVEYED,\n'
(ROOT/(name+'.str')).write_text(header+'0, 0, 0, 0, 0, 0, 0\n'+''.join(f'1, {x:.6f}, {y:.6f}, {z:.6f}, 0, 0, 0\n' for x,y,z in vertices)+'0, 0, 0, 0, 0, 0, 0\n',encoding='utf-8')
(ROOT/(name+'.dtm')).write_text(header+f'POINTS {len(vertices)}\nTRIANGLES {len(faces)}\n'+''.join(f'{i}, {a+1}, {b+1}, {c+1}, 0, 0, 0\n' for i,(a,b,c) in enumerate(faces,1)),encoding='utf-8')
(ROOT/(name+'.ts')).write_text('GOCAD TSurf 1\nHEADER {\nname:SIMULATED_1_1_surrounding_tunnels\n*solid*color:0.95 0.65 0.15 1\n}\nTFACE\n'+''.join(f'VRTX {i} {x:.6f} {y:.6f} {z:.6f}\n' for i,(x,y,z) in enumerate(vertices,1))+''.join(f'TRGL {a+1} {b+1} {c+1}\n' for a,b,c in faces)+'END\n',encoding='utf-8')
(ROOT/'Simulated_Tunnel_Centerlines.json').write_text(json.dumps({'simulation':True,'source':str(source),'coordinateMapping':'保持原文件X,Y,Z及37带号，不交换坐标轴','levels':levels,'clearance':40,'paths':paths},ensure_ascii=False,indent=2),encoding='utf-8')
# 验证三角网索引、有限值、退化面和每段封闭性。
assert all(math.isfinite(v) for p in vertices for v in p)
assert all(0<=i<len(vertices) for f in faces for i in f)
edges={}
for a,b,c in faces:
 assert len({a,b,c})==3
 for u,v in [(a,b),(b,c),(c,a)]:
  e=tuple(sorted((u,v)));edges[e]=edges.get(e,0)+1
assert all(n==2 for n in edges.values())
print(json.dumps({'vertices':len(vertices),'triangles':len(faces),'levels':levels,'bounds':[[min(p[i] for p in vertices),max(p[i] for p in vertices)] for i in range(3)],'closedMeshes':True},ensure_ascii=False))
