from pathlib import Path
import tokenize,io,ast,re,json
root=Path(__file__).resolve().parents[1]
dict_={}
for line in (root/'tools/english-glossary.txt').read_text(encoding='utf-8-sig').splitlines():
 if '|' in line and not line.startswith('#'):
  k,v=line.split('|',1);dict_[k]=v
pattern=re.compile('|'.join(re.escape(k) for k in sorted(dict_,key=len,reverse=True)))
missing=[]
for f in (root/'backend').rglob('*.py'):
 if 'vendor' in f.parts:continue
 original=root.parent/'三维智库'/'backend'/f.relative_to(root/'backend')
 source=original.read_text(encoding='utf-8-sig');lines=source.splitlines(keepends=True);offset=[0]
 for line in lines:offset.append(offset[-1]+len(line))
 edits=[]
 for t in tokenize.generate_tokens(io.StringIO(source).readline):
  if t.type!=tokenize.STRING or not re.search('[\u3400-\u9fff]',t.string):continue
  context=lines[t.start[0]-1]
  if f.name=='coord_native.py' and not (('raise ' in context and t.start[1]>=context.index('raise ')) or "'message':" in context):continue
  try:value=ast.literal_eval(t.string)
  except Exception:continue
  if not isinstance(value,str):continue
  translated=dict_.get(value)
  if translated is None:translated=re.sub('[\u3400-\u9fff]+',lambda m:dict_.get(m[0],pattern.sub(lambda s:' '+dict_[s[0]]+' ',m[0]).strip()),value)
  if re.search('[\u3400-\u9fff]',translated):missing.append({'file':str(f),'text':value,'partial':translated})
  edits.append((offset[t.start[0]-1]+t.start[1],offset[t.end[0]-1]+t.end[1],repr(translated)))
 for start,end,text in sorted(edits,reverse=True):source=source[:start]+text+source[end:]
 compile(source,str(f),'exec');f.write_text(source,encoding='utf-8')
(root/'tools/python-untranslated.json').write_text(json.dumps(missing,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'Python localization: {len(missing)} unresolved messages')
