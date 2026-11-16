// A standalone Markdown renderer. Parsing state belongs to one document only.
const escaped = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const esc = (s, all = false) => s.replace(all ? /[&<>"']/g : /[<>"']|&(?!(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|\w+);)/g, c => escaped[c]);
const punct = /[\p{P}\p{S}]/u;
const unescape = s => s.replace(/\\([\p{P}\p{S}])/gu, '$1');
const norm = s => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
function numeric(s) {
  if (!/&#(?:\d{1,7}|[xX][\da-fA-F]{1,6});/.test(s)) return s;
  return s.replace(/&#(?:(\d{1,7})|[xX]([\da-fA-F]{1,6}));|&(?!(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|\w+);)/g, (m,d,h) => {
    if (d === undefined && h === undefined) return '&amp;';
    let n = parseInt(d || h, d === undefined ? 16 : 10);
    return n === 38 ? '&amp;' : !n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '\ufffd' : String.fromCodePoint(n);
  });
}
function uri(s) { try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; } }
function tabs(s, col=0) { return s.replace(/[^\t]*\t/g, m => { col += m.length-1; const n=4-col%4; col+=n; return m.slice(0,-1)+' '.repeat(n); }); }
function ge(s) { let a=s.split('\n'), i=a.length-1; while(i>=0 && /^[ \t]*$/.test(a[i])) i--; return a.length-i>2 ? a.slice(0,i+1).join('\n') : s; }
const tags = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const blockHTML = new RegExp('^ {0,3}(?:</?(?:'+tags+')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
const htmlTag = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>)/;
const hr = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/;
const fence = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;
const bullet = /^( {0,3})([*+-]|\d{1,9}[.)])([ \t].*)?$/;
const setext = /^ {0,3}(=+|-+)[ \t]*$/;
const indentCode = /^(?: {4}| {0,3}\t)\S?/;
function cells(s, count) {
  let arr=[], start=0;
  for(let i=0;i<s.length;i++) if(s[i]==='|') {let n=0;for(let j=i-1;j>=0&&s[j]==='\\';j--)n++;if(!(n&1)){arr.push(s.slice(start,i));start=i+1;}}
  arr.push(s.slice(start)); if(!arr[0].trim())arr.shift();if(arr.length&&!arr.at(-1).trim())arr.pop();
  if(count){arr.length=Math.min(arr.length,count);while(arr.length<count)arr.push('');}
  return arr.map(x=>x.trim().replace(/\\\|/g,'|'));
}
function tableHead(a,i) {
  if(i+1>=a.length || !/^ *[^\n ].*/.test(a[i]) || !/^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(a[i+1]) || !/[:|]/.test(a[i+1])) return null;
  let h=cells(a[i]), d=a[i+1].replace(/^\||\| *$/g,'').split('|');if(h.length!==d.length)return null;
  return {h,align:d.map(x=>/^ *:-+: *$/.test(x)?'center':/^ *-+: *$/.test(x)?'right':/^ *:-+ *$/.test(x)?'left':null)};
}
function interrupts(a,i, listAny=false, table=true) {
  let s=a[i];
  return hr.test(s)||heading.test(s)||fence.test(s)||/^ {0,3}>/.test(s)||blockHTML.test(s)||(listAny?/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/:/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/).test(s)||(table&&tableHead(a,i));
}
function htmlBlock(s) {
  const first=s.slice(0,s.indexOf('\n')<0?s.length:s.indexOf('\n'));let m;
  if((m=/^ {0,3}<(script|pre|style|textarea)[\s>]/i.exec(s))) {
    const r=new RegExp('</'+m[1]+'>[^\\n]*\\n*','i');let end=r.exec(s);return ge(end?s.slice(0,end.index+end[0].length):s);
  }
  for(const [re,close] of [[/^ {0,3}<!--/,/-->|(?<=<!--)-?>/],[/^ {0,3}<\?/,/\?>/],[/^ {0,3}<!\[CDATA\[/,/\]\]>/],[/^ {0,3}<![A-Z]/i,/>/]]) if(re.test(s)) {
    let end=close.exec(s);if(!end)return s;let i=s.indexOf('\n',end.index+end[0].length);if(i<0)return s;while(s[i]==='\n')i++;return ge(s.slice(0,i));
  }
  let generic=false;
  if(!blockHTML.test(first)) {let t=htmlTag.exec(first.trimStart());generic=!!t && /^<\/?[a-z]/i.test(t[0]) && !/^<(?:script|pre|style|textarea)(?![a-z0-9-])/i.test(t[0]) && /^[ \t]*(?:\n|$)/.test(s.trimStart().slice(t[0].length)); if(!generic)return null;}
  let end=/\n[ \t]*\n/.exec(s);return ge(end?s.slice(0,end.index+end[0].length):s);
}
function definition(s) {
  const m=/^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)))? *(?:\n+|$)/.exec(s);
  if(!m)return null;if(m[2][0]!=='<'&&balance(m[2])!==-1)return null;
  return {raw:m[0].replace(/\n+$/,''),key:norm(m[1]),href:unescape(m[2].replace(/^<(.*)>$/,'$1')),title:m[3]?unescape(m[3].slice(1,-1)):''};
}
function balance(s) {let n=0;for(let i=0;i<s.length;i++){if(s[i]==='\\')i++;else if(s[i]==='(')n++;else if(s[i]===')'&&--n<0)return i;}return n>0?-2:-1;}

// Block nodes defer inline work until all definitions have been collected.
function blocks(src, ctx, top=true, existing=[], merge=false) {
  const a=src.split('\n'), offsets=[];let off=0;for(const l of a){offsets.push(off);off+=l.length+1;}
  const out=existing;let i=0;
  const position=()=>offsets[i]??src.length;
  const consume=n=>{const end=position()+n;while(i<a.length&&offsets[i]+a[i].length<end)i++;if(i<a.length&&offsets[i]<end){a[i]=a[i].slice(end-offsets[i]);offsets[i]=end;}};
  while(i<a.length && position()<src.length) {
    let s=a[i], m, start=position(), last=out.at(-1);
    if(/^[ \t]*$/.test(s)) {
      let j=i;while(i<a.length&&/^[ \t]*$/.test(a[i]))i++;
      const raw=src.slice(start,Math.min(src.length,position()));
      if(raw==='\n'&&last)last.raw+='\n';else out.push({type:'space',raw});continue;
    }
    if(indentCode.test(s)) {
      let j=i+1;while(j<a.length){if(indentCode.test(a[j])&&a[j].trim()){j++;continue;}if(!a[j].trim()){j++;continue;}break;}
      let raw=ge(src.slice(start,Math.min(src.length,offsets[j]??src.length)));
      let text=raw.replace(/^(?: {0,3}\t| {1,4})/gm,'');consume(raw.length);
      if(last&&(last.type==='p'||last.type==='text')) {last.text+='\n'+text;last.raw+='\n'+raw;}
      else out.push({type:'code',raw,text,lang:''});continue;
    }
    if((m=fence.exec(s))) {
      let j=i+1, close=new RegExp('^ {0,3}'+m[1][0]+'{'+m[1].length+',} *$');while(j<a.length&&!close.test(a[j]))j++;
      let text=a.slice(i+1,j).join('\n');if(j===a.length&&text.endsWith('\n'))text=text.slice(0,-1);
      let ind=/^(\s+)```/.exec(s);if(ind)text=text.split('\n').map(l=>l.slice(Math.min((/^\s*/.exec(l)[0]).length,ind[1].length))).join('\n');
      let end=j<a.length?offsets[j]+a[j].length:src.length;let raw=src.slice(start,end);consume(raw.length);
      out.push({type:'code',raw,text,lang:unescape(m[2].trim())});continue;
    }
    if((m=heading.exec(s))) {let text=m[2].trim();if(/#$/.test(text)){let t=text.replace(/#+$/,'');if(!t||/[ \t]$/.test(t))text=t.trim();}out.push({type:'h',raw:s,text,depth:m[1].length});consume(s.length);continue;}
    if(hr.test(s)){out.push({type:'hr',raw:s});consume(s.length);continue;}
    if(/^ {0,3}>/.test(s)) {
      const q=quote(src.slice(start),ctx);out.push(q);consume(q.raw.length);continue;
    }
    if(bullet.test(s)) {let l=list(src.slice(start),ctx);if(l){out.push(l);consume(l.raw.length);continue;}}
    if(/^ {0,3}</.test(s)) {let raw=htmlBlock(src.slice(start));if(raw){out.push({type:'html',raw,text:raw});consume(raw.length);continue;}}
    if(/^ {0,3}\[/.test(s)) {let d=definition(src.slice(start));if(d){consume(d.raw.length);if(last&&(last.type==='p'||last.type==='text')){last.raw+='\n'+d.raw;last.text+='\n'+d.raw;}else{if(!ctx.refs[d.key])ctx.refs[d.key]=d;out.push({type:'def',raw:d.raw});}continue;}}
    let th=tableHead(a,i);
    if(th) {
      let j=i+2;while(j<a.length&&!/^ *$/.test(a[j])&&!interrupts(a,j,false,false)&&!/^(?: {4}| {0,3}\t)[^\n]/.test(a[j])&&!/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(a[j]))j++;
      let rows=a.slice(i+2,j);if(!rows.join('\n').trim())rows=[];else if(rows.length&&rows.at(-1)==='')rows.pop();
      let raw=src.slice(start,(offsets[j]??src.length)).replace(/\n+$/,'');out.push({type:'table',raw,...th,rows:rows.map(r=>cells(r,th.h.length))});consume(raw.length);continue;
    }
    // Setext scanning is permitted inside a list even though ordinary text is line based.
    let j=i+1, isSet=false;
    if(!/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(s)&&!/^ {0,3}<[^\n>]+>$/.test(s)) {
      while(j<a.length&&a[j].trim()) {
        if(setext.test(a[j])){isSet=true;break;}
        if(interrupts(a,j,true)||/^ {0,3}<[^\n>]+>$/.test(a[j])||/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(a[j]))break;j++;
      }
    }
    if(isSet){let raw=src.slice(start,offsets[j]+a[j].length);out.push({type:'h',raw,text:a.slice(i,j).join('\n').trim(),depth:a[j].trim()[0]==='='?1:2});consume(raw.length);continue;}
    j=i+1;if(top)while(j<a.length&&a[j].length&&!(j<a.length-1&&/^[ \t]+$/.test(a[j]))&&!interrupts(a,j))j++;
    let text=a.slice(i,j).join('\n'), type=top?'p':'text', raw=text;
    if(last&&((type==='text'&&last.type==='text')||(merge&&type==='p'&&last.type==='p'))){last.text+='\n'+text;last.raw+=(last.raw.endsWith('\n')?'':'\n')+raw;}else out.push({type,raw,text});
    consume(raw.length);merge=false;
  }
  return out;
}
function list(src,ctx) {
  let a=src.split('\n'), pos=[], n=0;for(let l of a){pos.push(n);n+=l.length+1;}
  let first=bullet.exec(a[0]);if(!first)return null;
  let ordered=first[2].length>1, marker=first[2].at(-1), items=[], loose=false, pending=false,i=0;
  while(i<a.length) {
    const m=bullet.exec(a[i]);if(!m||hr.test(a[i])||(ordered?m[2].length===1||m[2].at(-1)!==marker:m[2]!==marker))break;
    let start=i, col=m[1].length+m[2].length;
    let body=(m[3]||'').replace(/^[ \t]+/,x=>tabs(x,col));let blank=!body.trim();let pad=blank?1:body.search(/[^ ]/);if(pad>4)pad=1;
    let indent=col+pad, text=blank?'':body.slice(pad), prev=body;i++;
    let lim=Math.max(0,Math.min(3,indent-1));
    const lead=new RegExp('^ {0,'+lim+'}');
    const stop=l=>{let k=lead.exec(l)[0].length;let r=l.slice(k);return /^ {0}/.test(r)&&k===l.search(/[^ ]/)&&( /^(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>)/.test(r)||bullet.test(r)||hr.test(r)||blockHTML.test(r));};
    if(blank&&i<a.length&&!a[i].trim())i++;
    else while(i<a.length && pos[i]<src.length) {
      let original=a[i], line=original.replace(/^[ \t]+/,x=>tabs(x));
      if(stop(original))break;
      if(line.search(/[^ ]/)>=indent || !original.trim())text+='\n'+line.slice(indent);
      else {
        if(blank||prev.replace(/\t/g,'    ').search(/[^ ]/)>=4||fence.test(prev)||heading.test(prev)||blockHTML.test(prev)||hr.test(prev))break;
        text+='\n'+(setext.test(original)?'    '+line.replace(/^ {0,3}/,''):original);
      }
      blank=!original.trim();prev=line.slice(indent);i++;
    }
    let raw=src.slice(pos[start],Math.min(src.length,pos[i]??src.length));
    if(pending)loose=true;else if(/\n[ \t]*\n[ \t]*$/.test(raw))pending=true;
    items.push({raw,text});
  }
  if(!items.length)return null;
  items.at(-1).raw=items.at(-1).raw.trimEnd();items.at(-1).text=items.at(-1).text.trimEnd();
  for(let item of items) {item.task=/^\[[ xX]\][ \t]+\S/.test(item.text);item.children=blocks(item.text,ctx,false);if(item.children.some(t=>t.type==='space'&&/\n.*\n/.test(t.raw)))loose=true;}
  for(let item of items) {
    const t=item.children[0];if(item.task&&t&&(t.type==='text'||t.type==='p')) {item.checked=/\[[xX]\]/.test(item.raw.match(/\[[ xX]\]/)?.[0]||'');t.text=t.text.replace(/^\[[ xX]\][ \t]+/,'');item.checkbox=true;}
    if(loose)for(let t of item.children)if(t.type==='text')t.type='p';
  }
  return {type:'list',raw:src.slice(0,Math.min(src.length,pos[i]??src.length)).trimEnd(),ordered,start:ordered?parseInt(first[2]):1,loose,items};
}
function quote(src,ctx) {
  const lines=src.split('\n');let end=0;
  while(end<lines.length) {
    if(/^ {0,3}>/.test(lines[end])) {const nonblank=!/^ {0,3}> ?[ \t]*$/.test(lines[end]);end++;while(nonblank&&end<lines.length&&lines[end].trim()&&!interrupts(lines,end,true,false))end++;}
    else break;
  }
  let pending=lines.slice(0,end), raw='', children=[], text='';
  while(pending.length) {
    let k=0, seen=false;
    while(k<pending.length){if(/^ {0,3}>/.test(pending[k]))seen=true;else if(seen)break;k++;}
    let chunk=pending.slice(0,k).join('\n');pending=pending.slice(k);
    let inner=chunk.replace(/^( {0,3}>)([ \t]+)/gm,(_,p,w)=>p+tabs(w,p.length)).replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,'\n    $1').replace(/^ {0,3}>[ \t]?/gm,'');
    raw+=(raw?'\n':'')+chunk;text+=(text?'\n':'')+inner;blocks(inner,ctx,true,children,true);
    if(!pending.length)break;
    const last=children.at(-1);if(!last||['code','h','hr','html','table'].includes(last.type))break;
    if(last.type==='quote'||last.type==='list') {
      const rest=pending.join('\n'), added=last.type==='quote'?rest.replace(/^ {0,3}>[ \t]?/gm,''):rest;
      const combined=last.raw+'\n'+added;
      const replacement=last.type==='quote'?quote(combined,ctx):list(combined,ctx);
      children[children.length-1]=replacement;
      let used=replacement.raw.length>last.raw.length?combined.slice(last.raw.length+1,replacement.raw.length).split('\n').length:0;
      if(used){raw+='\n'+pending.slice(0,used).join('\n');pending=pending.slice(used);}else break;
      if(last.type==='quote'&&(!pending.length||!/^ {0,3}>/.test(pending[0])))break;
    }
  }
  return {type:'quote',raw,children,text};
}
const angleAuto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const emailSource='[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const autoURL=new RegExp('^(?:mailto:'+emailSource+'|xmpp:'+emailSource+'(?:/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])://|www\\.)(?:[a-zA-Z0-9-]+\\.?)+[^\\s<]*|^'+emailSource);
const backpedal=/(?:[^?!.,:;*_ '"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const textRun = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/;
const codeSpan=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const label='(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const refLabel='(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const inlineLink=new RegExp('^!?\\[('+label+')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
const fullRef=new RegExp('^!?\\[('+label+')\\]\\[('+refLabel+')\\]');
const shortRef=new RegExp('^!?\\[('+refLabel+')\\](?:\\[\\])?');
const maskRef=new RegExp('!?\\[('+label+')\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()','g');
const blockSkip=/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function containsLink(s,ctx) {
  for(const m of s.matchAll(blockSkip))if(inlineLink.test(m[0])&&s[m.index-1]!=='!')return true;
  for(const m of s.matchAll(maskRef)){let raw=m[0],j=raw.lastIndexOf('[');if(raw[0]!=='!'&&ctx.refs[norm(raw.slice(j+1,-1))]&&!(j>1&&containsLink(raw.slice(1,j-1),ctx)))return true;}
  return false;
}
function masked(s,ctx) {
  const maskReference=m=>{
    const j=m.lastIndexOf('[');if(!ctx.refs[norm(m.slice(j+1,-1))])return m;
    if(j>1&&m[0]!=='!'){let inner=m.slice(1,j-1);if(containsLink(inner,ctx))return '['+inner.replace(maskRef,maskReference)+']['+'a'.repeat(m.length-j-2)+']';}
    return '['+'a'.repeat(m.length-2)+']';
  };
  let t=s.replace(maskRef,maskReference);
  t=t.replace(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,(m,c,p)=>p?'+'.repeat(m.length):c?c+m.slice(c.length,-c.length).replace(/`/g,'+')+c:m);
  return t.replace(blockSkip,m=>'['+'a'.repeat(m.length-2)+']');
}
// Delimiter classification uses Unicode punctuation, as does the oracle.
function closerPattern(c,tilde=false) {
  const p=tilde?'[\\p{P}\\p{S}]':c==='*'?'(?!~)[\\p{P}\\p{S}]':'[\\p{P}\\p{S}]';
  const ps=tilde?'[\\s\\p{P}\\p{S}]':c==='*'?'(?!~)[\\s\\p{P}\\p{S}]':'[\\s\\p{P}\\p{S}]';
  const np=tilde?'[^\\s\\p{P}\\p{S}]':c==='*'?'(?:[^\\s\\p{P}\\p{S}]|~)':'[^\\s\\p{P}\\p{S}]';
  const d=c==='*'?'\\*':c, run=tilde?'~~?':d+'+';
  let prefix=tilde?'^[^~]+(?=[^~])':c==='*'?'^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])':'^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])';
  return new RegExp(prefix+'|(?!'+d+')'+p+'('+run+')(?=[\\s]|$)|'+np+'('+run+')(?!'+d+')(?='+ps+'|$)|(?!'+d+')'+ps+'('+run+')(?='+np+')|[\\s]('+run+')(?!'+d+')(?='+p+')|(?!'+d+')'+p+'('+run+')(?!'+d+')(?='+p+')'+(c==='_'?'':'|'+np+'('+run+')(?='+np+')'),'gu');
}
const rightStar=closerPattern('*'),rightUnd=closerPattern('_'),rightDel=closerPattern('~',true);
function emphasis(s,at,mask,prev,del=false) {
  let c=s[at],k=at;while(s[k]===c)k++;let count=k-at;if(del&&count>2)return null;
  const next=String.fromCodePoint(s.codePointAt(k)||32);if(/\s/.test(next)||next===c)return null;
  let earlier=at;while(earlier>0&&mask[earlier-1]===c)earlier--;
  let prior=[...mask.slice(Math.max(0,earlier-2),earlier)].at(-1)||'';
  const punctuation=x=>!!x&&x!=='*'&&x!=='_'&&/[\s\p{P}\p{S}]/u.test(x);
  let priorP=prior==='*'||prior==='_'||punctuation(prior);
  const originalPrev=prev;
  if(!del&&earlier<at)prev=prior;
  let np=punct.test(next)&&(!(!del&&c==='*')||next!=='~');
  if(c==='_'&&!np&&/[\p{L}\p{N}]/u.test(prev))return null;
  if(np&&prev&&!(earlier<at&&!del?priorP:punctuation(prev)))return null;
  let balance=count, skip=0, openerSum=at-earlier+count, both=!del&&!!prior.trim()&&(np||c==='*'&&!priorP);
  const re=del?rightDel:c==='*'?rightStar:rightUnd, rest=mask.slice(k);re.lastIndex=0;
  let m;
  while((m=re.exec(rest))) {
    const run=m[1]||m[2]||m[3]||m[4]||m[5]||m[6];if(!run)continue;let n=run.length;if(del&&n!==count)continue;
    if(m[3]||m[4]){balance+=n;continue;}
    if(!del&&(m[5]||m[6]||both)) {
      if(originalPrev===c&&(m[5]||m[6]))break;
      if(openerSum%3&&(openerSum+n)%3===0){skip+=n;continue;}
    }
    balance-=n;if(balance>0)continue;
    n=Math.min(n,n+balance+skip);
    const end=k+m.index+String.fromCodePoint(m[0].codePointAt(0)).length+n;
    let width=del?count:Math.min(count,n)%2?1:2;
    return {end,width,tag:del?'del':width===1?'em':'strong'};
  }
  return null;
}
function crosses(s,label,base) {
  for(let i=0;i<label.length;i++) {
    if(label[i]==='\\'){i++;continue;}
    if(label[i]==='`'){let m=codeSpan.exec(label.slice(i));if(m){i+=m[0].length-1;continue;}}
    if(label[i]==='<'){let m=htmlTag.exec(s.slice(base+i))||angleAuto.exec(s.slice(base+i));if(m){if(m[0].length>label.length-i)return true;i+=m[0].length-1;}}
  }
  return false;
}
function inline(s,ctx,state=null, plain=false) {
  if(!state){state=ctx.inlineState||(ctx.inlineState={inLink:false,raw:false,emitted:false});state.raw=false;}
  let out='',at=0,prev='',mask=null;
  while(at<s.length) {
    const c=s[at];let tail, m, end=0, value='',keepPrev=false;
    if(c==='\\'&&(m=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/.exec(s.slice(at)))){end=at+2;value=plain?m[1]:esc(m[1]);}
    else if(c==='<'&&(m=htmlTag.exec(s.slice(at)))) {
      value=m[0];end=at+value.length;
      if(/^<a /i.test(value)&&!state.inLink)state.inLink=true;else if(/^<\/a>/i.test(value)&&state.inLink)state.inLink=false;
      if(/^<(pre|code|kbd|script)(\s|>)/i.test(value)&&!state.raw)state.raw=true;else if(/^<\/(pre|code|kbd|script)(\s|>)/i.test(value)&&state.raw)state.raw=false;
    }
    if(!end&&(c==='['||c==='!'&&s[at+1]==='[')) {
      tail=s.slice(at);let link=inlineLink.exec(tail), target=null, raw='', labelText='', image=c==='!', base=image?2:1;
      if(link&&!crosses(tail,link[1],base)) {
        let href=link[2].trim(), valid=true, raw=link[0],title=link[3]?link[3].slice(1,-1):'';
        if(href[0]==='<') {let sl=0;for(let i=href.length-2;i>=0&&href[i]==='\\';i--)sl++;if(!href.endsWith('>')||(sl&1))valid=false;}
        else {let close=balance(href);if(close===-2)valid=false;else if(close>=0){raw=raw.slice(0,(image?5:4)+link[1].length+close).trim();href=href.slice(0,close);title='';}}
        let sl=0;for(let i=raw.length-2;i>=0&&raw[i]==='\\';i--)sl++;if(sl&1)valid=false;
        if(valid){target={href:unescape(href.replace(/^<(.*)>$/s,'$1')),title:unescape(title)};link=[raw,link[1]];}
      }
      if(!target){link=fullRef.exec(tail)||shortRef.exec(tail);if(link&&!crosses(tail,link[1],base))target=ctx.refs[norm(link[2]||link[1])];}
      if(target) {
        labelText=link[1].replace(/\\([\[\]])/g,'$1');raw=link[0];let child={inLink:true,raw:state.raw,emitted:false};
        const labelHTML=inline(labelText,ctx,child,plain||image);
        if(image||!child.emitted){
          end=at+raw.length;state.raw=child.raw;if(!image)state.emitted=true;
          let href=uri(target.href);
          if(plain)value=labelHTML;
          else if(image)value=href===null?esc(labelHTML):'<img src="'+esc(href)+'" alt="'+esc(labelHTML)+'"'+(target.title?' title="'+esc(target.title)+'"':'')+'>';
          else value=href===null?labelHTML:'<a href="'+esc(href)+'"'+(target.title?' title="'+esc(target.title)+'"':'')+'>'+labelHTML+'</a>';
        }
      }
      // Unresolved bracket syntax is emitted one character at a time, not a text run.
      if(!end&&link){end=at+1;value=c;}
    }
    if(!end&&(c==='*'||c==='_'||c==='~')) {
      if(mask===null)mask=masked(s,ctx);
      let e=emphasis(s,at,mask,prev,c==='~');if(e){let v=inline(s.slice(at+e.width,e.end-e.width),ctx,state,plain);value=plain?v:'<'+e.tag+'>'+v+'</'+e.tag+'>';end=e.end;}
    }
    if(!end&&c==='`'&&(m=codeSpan.exec(s.slice(at)))) {
      value=m[2].replace(/\n/g,' ');if(/[^ ]/.test(value)&&value[0]===' '&&value.at(-1)===' ')value=value.slice(1,-1);
      if(!plain)value='<code>'+esc(value,true)+'</code>';end=at+m[0].length;
    }
    if(!end&&(c===' '||c==='\\')&&(m=/^( {2,}|\\)\n(?!\s*$)[ \t]*/.exec(s.slice(at)))){end=at+m[0].length;value=plain?'':'<br>';}
    if(!end&&c==='<'&&(m=angleAuto.exec(s.slice(at)))) {
      const v=m[1], href=uri(/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(v)?v:'mailto:'+v);end=at+m[0].length;
      value=plain?v:href===null?esc(v,true):'<a href="'+esc(href,true)+'">'+esc(v,true)+'</a>';
    }
    if(!end&&!state.inLink&&(m=autoURL.exec(s.slice(at)))) {
      let v=m[0], href;
      if(!m[1]&&!/^(?:mailto|xmpp):/.test(v))href='mailto:'+v;
      else {let old;do{old=v;v=backpedal.exec(v)?.[0]||'';}while(old!==v);href=m[1]==='www.'?'http://'+v:v;}
      if(v){end=at+v.length;href=uri(href);value=plain?v:href===null?esc(v,true):'<a href="'+esc(href,true)+'">'+esc(v,true)+'</a>';}
    }
    if(!end) {
      m=textRun.exec(s.slice(at));let raw=m&&m[0]||c;end=at+raw.length;
      if(raw.at(-1)!=='_')prev=raw.at(-1);keepPrev=true;
      let v=state.raw?raw:numeric(raw);value=plain||state.raw?v:esc(v);
    }
    out+=value;at=end;if(!keepPrev)prev='';
  }
  return out;
}
function render(nodes,ctx) {
  let out='';
  for(const n of nodes) {
    switch(n.type) {
      case 'space':case 'def':break;
      case 'html':out+=n.text;break;
      case 'hr':out+='<hr>\n';break;
      case 'p':out+='<p>'+inline(n.text,ctx)+'</p>\n';break;
      case 'text':out+=inline(n.text,ctx);break;
      case 'h':out+='<h'+n.depth+'>'+inline(n.text,ctx)+'</h'+n.depth+'>\n';break;
      case 'code':{let lang=n.lang?.match(/^\S*/)[0];out+='<pre><code'+(lang?' class="language-'+esc(lang)+'"':'')+'>'+esc(n.text?n.text.replace(/\n$/,'')+'\n':'',true)+'</code></pre>\n';break;}
      case 'quote':out+='<blockquote>\n'+render(n.children,ctx)+'</blockquote>\n';break;
      case 'list':{
        let tag=n.ordered?'ol':'ul';out+='<'+tag+(n.ordered&&n.start!==1?' start="'+n.start+'"':'')+'>\n';
        for(const item of n.items){let html=render(item.children,ctx);if(item.checkbox){let check='<input '+(item.checked?'checked="" ':'')+'disabled="" type="checkbox"> ';html=n.loose?html.replace(/^<p>/,'<p>'+check):check+html;}out+='<li>'+html+'</li>\n';}out+='</'+tag+'>\n';break;
      }
      case 'table':{
        const row=(r,tag)=>'<tr>\n'+r.map((s,i)=>'<'+tag+(n.align[i]?' align="'+n.align[i]+'"':'')+'>'+inline(s,ctx)+'</'+tag+'>\n').join('')+'</tr>\n';
        out+='<table>\n<thead>\n'+row(n.h,'th')+'</thead>\n'+(n.rows.length?'<tbody>'+n.rows.map(r=>row(r,'td')).join('')+'</tbody>':'')+'</table>\n';break;
      }
    }
  }
  return out;
}
export function parse(markdown) {
  const ctx={refs:Object.create(null)};
  return render(blocks(markdown.replace(/\r\n|\r/g,'\n'),ctx),ctx);
}
