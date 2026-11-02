const fs=require('fs'),path=require('path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),original=path.resolve(root,'../三维智库');
const dict=Object.fromEntries(fs.readFileSync(path.join(__dirname,'english-glossary.txt'),'utf8').split(/\r?\n/).filter(s=>s&&s[0]!=='#'&&s.includes('|')).map(s=>{const i=s.indexOf('|');return[s.slice(0,i).replace(/^\uFEFF/,''),s.slice(i+1)];}));
const keys=Object.keys(dict).sort((a,b)=>b.length-a.length),missing=new Map(),preserved=[];
const terms=new RegExp(keys.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
function translate(s,quote){const esc=v=>quote?v.replaceAll(quote,'\\'+quote):v;return s.replace(/[\u3400-\u9fff]+/g,(phrase,offset)=>{let out=dict[phrase]!=null?esc(dict[phrase]):phrase.replace(terms,m=>' '+esc(dict[m])+' ').replace(/ +/g,' ').trim();if(/[\u3400-\u9fff]/.test(out))missing.set(phrase,out);if(/[A-Za-z0-9}]/.test(s[offset-1]||''))out=' '+out;if(/[A-Za-z0-9$]/.test(s[offset+phrase.length]||''))out+=' ';return out;}).replace(/，/g,', ').replace(/。/g,'. ').replace(/：/g,': ').replace(/；/g,'; ').replace(/、/g,', ').replace(/（/g,' (').replace(/）/g,') ').replace(/！/g,'!').replace(/？/g,'?').replace(/「/g,'“').replace(/」/g,'”');}
function protect(n,sf){
 const value=n.text||'',ctx=sf.text.slice(Math.max(0,n.pos-110),Math.min(sf.text.length,n.end+30));
 if(value.includes('const testFiles ='))return 'embedded diagnostic script';
 if(/^(?:[A-Za-z]:[\\/]|(?:src|assets|textures|图件)[\\/])/.test(value)&&!value.includes('<'))return 'path';
 // Keep original aliases and matching rules for Chinese input tables.
 let a=n.parent;while(a&&!ts.isArrayLiteralExpression(a)&&!ts.isStatement(a))a=a.parent;
 if(a&&ts.isArrayLiteralExpression(a)){
  const ancestor=sf.text.slice(Math.max(0,a.pos-90),a.pos);
  if(/findColumnIndex|findHeader|findCol|find\s*\(|find\s*$|indexOf|aliases|candidates/i.test(ancestor)||a.elements.some(e=>ts.isStringLiteral(e)&&/^(holeid|hole_id|east|easting|northing|north|elevation|azimuth|dip|lithology|depth|from|to|lineid|group|线号|线名|孔号|东坐标|北坐标|标高)$/i.test(e.text)))return 'data alias';
 }
 if(n.parent&&ts.isBinaryExpression(n.parent)&&/^(?:h|hh|hdr|header|headerName|gn|n|norm|col|columnName|key|k)$/.test(n.parent.left.getText(sf).trim()))return 'data comparison';
 if(/(?:includes|indexOf|test|replace)\s*\(\s*$/.test(sf.text.slice(Math.max(0,n.pos-40),n.pos))&&value.length<=6)return 'matching rule';
 return false;
}
const files=['main.js','preload.js',...fs.readdirSync(path.join(original,'src/app')).filter(n=>/\.(js|css)$/.test(n)).map(n=>'src/app/'+n),...fs.readdirSync(path.join(original,'desktop')).filter(n=>n.endsWith('.js')).map(n=>'desktop/'+n)];
let count=0;
for(const rel of files){let source=fs.readFileSync(path.join(original,rel),'utf8');
 if(rel.endsWith('.js')){const sf=ts.createSourceFile(rel,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];function walk(n){if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(n.kind)){if(/[\u3400-\u9fff]/.test(n.text)){const reason=protect(n,sf);if(reason)preserved.push({file:rel,text:n.text,reason});else{const start=n.getStart(sf),end=n.end,raw=source.slice(start,end);let text=translate(raw,raw[0]==='"'?'"':raw[0]===String.fromCharCode(39)?String.fromCharCode(39):String.fromCharCode(96));if(ts.isStringLiteral(n)&&ts.isBinaryExpression(n.parent)&&n.parent.operatorToken.kind===ts.SyntaxKind.PlusToken&&!n.text.includes('<')){if(n.parent.right===n&&!/^\s/.test(n.text))text=text[0]+' '+text.slice(1);if(n.parent.left===n&&!/\s$/.test(n.text))text=text.slice(0,-1)+' '+text.slice(-1);}if(text!==raw){edits.push({start,end,text});count++;}}}}ts.forEachChild(n,walk);}walk(sf);edits.sort((a,b)=>b.start-a.start).forEach(e=>{source=source.slice(0,e.start)+e.text+source.slice(e.end);});
 }else source=source.replace(/\/\*[\s\S]*?\*\//g,m=>m).replace(/content\s*:\s*(['"])(.*?)\1/g,(m,q,v)=>'content:'+q+translate(v)+q);
 fs.writeFileSync(path.join(root,rel),source);
}
let html=fs.readFileSync(path.join(original,'src/index8.html'),'utf8');
// Translate executable HTML text and attributes, excluding CSS and comments.
html=html.replace(/<!--[\s\S]*?-->|<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|[^<]+|<[^>]+>/gi,m=>/^<!--|^<style|^<script/i.test(m)?m:translate(m));
html=html.replace('lang="zh-CN"','lang="en"');
fs.writeFileSync(path.join(root,'src/index8.html'),html);
fs.writeFileSync(path.join(__dirname,'english-untranslated.json'),JSON.stringify([...missing],null,2));
fs.writeFileSync(path.join(__dirname,'english-preserved.json'),JSON.stringify(preserved,null,2));
console.log({translatedLiterals:count,untranslated:missing.size,preserved:preserved.length});console.log([...missing].map(r=>r.join(' => ')).join('\n'));
