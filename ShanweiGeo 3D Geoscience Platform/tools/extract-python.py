from pathlib import Path
import tokenize,io,json
root=Path('ShanweiGeo-English/backend')
rows=[]
for f in root.rglob('*.py'):
 if 'vendor' in f.parts:continue
 for t in tokenize.generate_tokens(io.StringIO(f.read_text(encoding='utf-8-sig')).readline):
  if t.type==tokenize.STRING and any('\u3400'<=c<='\u9fff' for c in t.string):rows.append({'file':str(f.relative_to(root)),'line':t.start[0],'text':t.string})
Path('ShanweiGeo-English/tools/python-strings.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
print('\n'.join(f'{r["file"]}:{r["line"]}: {r["text"]}' for r in rows))
