const fs=require('fs'),path=require('path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),rows=[];
const files=[path.join(root,'main.js'),path.join(root,'preload.js'),...fs.readdirSync(path.join(root,'src/app')).filter(n=>n.endsWith('.js')).map(n=>path.join(root,'src/app',n)),...fs.readdirSync(path.join(root,'desktop')).filter(n=>n.endsWith('.js')).map(n=>path.join(root,'desktop',n))];
for(const file of files){const source=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);function walk(n){if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||n.kind===ts.SyntaxKind.TemplateHead||n.kind===ts.SyntaxKind.TemplateMiddle||n.kind===ts.SyntaxKind.TemplateTail){if(/[\u3400-\u9fff]/.test(n.text))rows.push({file:path.relative(root,file),line:sf.getLineAndCharacterOfPosition(n.pos).line+1,text:n.text,context:source.slice(Math.max(0,n.pos-60),n.pos).replace(/\s+/g,' ')});}ts.forEachChild(n,walk);}walk(sf);}
let html=fs.readFileSync(path.join(root,'src/index8.html'),'utf8').replace(/<!--[\s\S]*?-->/g,'');rows.push({file:'src/index8.html',text:html});
fs.writeFileSync(path.join(__dirname,'english-source-strings.json'),JSON.stringify(rows,null,2));
const phrases=[...new Set(rows.flatMap(r=>r.text.match(/[\u3400-\u9fff]+/g)||[]))].sort((a,b)=>b.length-a.length);
fs.writeFileSync(path.join(__dirname,'english-phrases.txt'),phrases.join('\n'));console.log({literals:rows.length,phrases:phrases.length});console.log(phrases.slice(0,100).join('\n'));
