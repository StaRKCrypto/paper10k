/* PAPER10K original characters. Hand-made SVG, not derived from any NFT collection. */
(()=>{
const F=(x1,x2,y,r,eye,mx,my,w=10)=>`
<g class="f f-idle"><ellipse cx="${x1}" cy="${y}" rx="${r}" ry="${r*1.25}" fill="${eye}"/><ellipse cx="${x2}" cy="${y}" rx="${r}" ry="${r*1.25}" fill="${eye}"/><circle cx="${x1+r*.35}" cy="${y-r*.45}" r="${r*.38}" fill="#fff"/><circle cx="${x2+r*.35}" cy="${y-r*.45}" r="${r*.38}" fill="#fff"/><path d="M${mx-w/2} ${my} q${w/2} ${w*.45} ${w} 0" stroke="#2a1420" stroke-width="2.4" fill="none" stroke-linecap="round"/></g>
<g class="f f-happy"><path d="M${x1-r} ${y+1} q${r} ${-r*1.8} ${2*r} 0 M${x2-r} ${y+1} q${r} ${-r*1.8} ${2*r} 0" stroke="#2a1420" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M${mx-w*.7} ${my-2} h${w*1.4} q0 ${w*1.1} ${-w*.7} ${w*1.1} q${-w*.7} 0 ${-w*.7} ${-w*1.1}z" fill="#2a1420"/><path d="M${mx-w*.4} ${my+w*.75} q${w*.4} ${-w*.45} ${w*.8} 0 q${-w*.4} ${w*.35} ${-w*.8} 0z" fill="#ff6fa8"/></g>
<g class="f f-sad"><path d="M${x1-r} ${y} q${r} ${r*.9} ${2*r} 0 M${x2-r} ${y} q${r} ${r*.9} ${2*r} 0" stroke="#2a1420" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M${x1-r*1.2} ${y-r*1.6} l${r*2} ${r*.6} M${x2+r*1.2} ${y-r*1.6} l${-r*2} ${r*.6}" stroke="#2a1420" stroke-width="2"/><path class="tear" d="M${x1} ${y+r} q-3 6 0 8 q3 -2 0 -8z" fill="#6cc8ff"/><path d="M${mx-w/2} ${my+4} q${w/2} ${-w*.5} ${w} 0" stroke="#2a1420" stroke-width="2.4" fill="none" stroke-linecap="round"/></g>
<g class="f f-shock"><circle cx="${x1}" cy="${y}" r="${r*1.45}" fill="#fff" stroke="#2a1420" stroke-width="1.5"/><circle cx="${x2}" cy="${y}" r="${r*1.45}" fill="#fff" stroke="#2a1420" stroke-width="1.5"/><circle cx="${x1}" cy="${y}" r="${r*.45}" fill="#111"/><circle cx="${x2}" cy="${y}" r="${r*.45}" fill="#111"/><ellipse cx="${mx}" cy="${my+3}" rx="${w*.38}" ry="${w*.55}" fill="#2a1420"/></g>
<g class="f f-dead"><path d="M${x1-r} ${y-r} l${2*r} ${2*r} M${x1+r} ${y-r} l${-2*r} ${2*r} M${x2-r} ${y-r} l${2*r} ${2*r} M${x2+r} ${y-r} l${-2*r} ${2*r}" stroke="#2a1420" stroke-width="3" stroke-linecap="round"/><path d="M${mx-w*.6} ${my+2} q${w*.3} -4 ${w*.6} 0 t${w*.6} 0" stroke="#2a1420" stroke-width="2.4" fill="none"/><path d="M${mx+w*.1} ${my+3} q2 7 5 2" fill="#ff6fa8"/></g>
<g class="f f-cope"><path d="M${x1-r} ${y} h${2*r} M${x2-r} ${y} h${2*r}" stroke="#2a1420" stroke-width="3" stroke-linecap="round"/><path d="M${mx-w*.7} ${my} q${w*.35} ${w*.5} ${w*.7} 0 t${w*.7} 0" stroke="#2a1420" stroke-width="2.4" fill="none" stroke-linecap="round"/><path class="sweat" d="M${x2+r*2.4} ${y-r*2} q-4 7 0 9 q4 -2 0 -9z" fill="#8fd8ff"/></g>`;
const shadow='<ellipse class="shd" cx="60" cy="134" rx="30" ry="5" fill="#000" opacity=".45"/>';
const S={
punk:{name:'pxl_guy',role:'pixel punk',svg:`${shadow}<g class="bod" shape-rendering="crispEdges">
<rect x="34" y="96" width="52" height="36" fill="#1b1b2e"/><rect x="34" y="96" width="52" height="6" fill="#ff4fa8"/><rect x="56" y="102" width="8" height="30" fill="#2bff88"/>
<g class="arm arm-l"><rect x="24" y="98" width="10" height="28" fill="#1b1b2e"/><rect x="24" y="124" width="10" height="8" fill="#e0a872"/></g>
<g class="arm arm-r"><rect x="86" y="98" width="10" height="28" fill="#1b1b2e"/><rect x="86" y="124" width="10" height="8" fill="#e0a872"/></g>
<rect x="52" y="86" width="16" height="12" fill="#d29560"/>
<g class="head"><rect x="36" y="34" width="48" height="54" fill="#e0a872"/><rect x="36" y="80" width="48" height="8" fill="#c88c58"/>
<rect x="32" y="52" width="4" height="14" fill="#d29560"/><rect x="84" y="52" width="4" height="14" fill="#d29560"/><rect x="85" y="64" width="3" height="5" fill="#ffe14d"/>
<rect x="44" y="12" width="8" height="24" fill="#2bff88"/><rect x="54" y="6" width="8" height="30" fill="#2bff88"/><rect x="64" y="10" width="8" height="26" fill="#2bff88"/><rect x="74" y="18" width="6" height="18" fill="#2bff88"/><rect x="44" y="12" width="36" height="4" fill="#1fd06c" opacity=".6"/>
<rect x="36" y="34" width="48" height="6" fill="#222"/>
<rect x="40" y="44" width="40" height="3" fill="#222" class="brow"/></g></g>
<g class="face">${F(50,70,58,4,'#1b1b2e',60,74,12)}</g>
<g class="prop"><rect x="74" y="74" width="20" height="3" fill="#eee"/><rect x="92" y="74" width="3" height="3" fill="#ff7b2b"/></g>`},
girl:{name:'mi_lady',role:'anime girl',svg:`${shadow}<g class="bod">
<path d="M20 70 Q16 120 34 128 L86 128 Q104 120 100 70Z" fill="#2a1d45"/>
<path d="M38 100 Q60 92 82 100 L88 132 L32 132Z" fill="#ffffff"/><path d="M50 100 L60 112 L70 100" fill="#ff4fa8"/><path d="M38 100 Q60 108 82 100" stroke="#8b5cff" stroke-width="3" fill="none"/>
<g class="arm arm-l"><path d="M34 104 q-10 12 -6 26" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="28" cy="130" r="4.5" fill="#ffe0d0"/></g>
<g class="arm arm-r"><path d="M86 104 q10 12 6 26" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="92" cy="130" r="4.5" fill="#ffe0d0"/></g>
<g class="head"><rect x="53" y="82" width="14" height="14" fill="#f5cdbb"/><ellipse cx="60" cy="58" rx="30" ry="32" fill="#ffe3d6"/>
<path d="M28 60 Q24 20 60 18 Q96 20 92 60 Q90 40 78 34 Q72 46 56 44 Q64 36 62 30 Q48 44 32 46 Q28 52 28 60Z" fill="#2a1d45"/>
<path d="M44 26 q6 -6 14 -4" stroke="#6e58b8" stroke-width="3" fill="none" opacity=".8"/>
<g class="bow"><path d="M78 20 l14 -10 l2 16z M78 20 l-4 -14 l14 4z" fill="#ff4fa8"/><circle cx="80" cy="18" r="3" fill="#ffe14d"/></g>
<ellipse cx="40" cy="70" rx="6" ry="3.5" fill="#ff8fc0" opacity=".55"/><ellipse cx="80" cy="70" rx="6" ry="3.5" fill="#ff8fc0" opacity=".55"/></g></g>
<g class="face">${F(46,74,60,5.2,'#5a7bff',60,76,9)}</g>
<g class="prop"><text x="94" y="50" font-size="13">✨</text></g>`},
cat:{name:'kitty.exe',role:'cat',svg:`${shadow}<g class="bod">
<path class="tail" d="M88 118 q26 -4 20 -34 q-2 -8 -8 -4 q6 22 -14 28z" fill="#f29a2e"/>
<ellipse cx="60" cy="112" rx="28" ry="22" fill="#f6a83a"/><ellipse cx="60" cy="118" rx="16" ry="14" fill="#fff1dc"/>
<g class="arm arm-l"><ellipse cx="42" cy="128" rx="8" ry="5" fill="#fff1dc"/></g><g class="arm arm-r"><ellipse cx="78" cy="128" rx="8" ry="5" fill="#fff1dc"/></g>
<g class="head"><path d="M26 40 L32 8 L52 28 L68 28 L88 8 L94 40 Q102 86 60 90 Q18 86 26 40Z" fill="#f6a83a"/>
<path d="M33 14 L36 32 L46 27z M87 14 L84 32 L74 27z" fill="#ff9cc7"/>
<path d="M50 30 l4 10 M60 28 v11 M70 30 l-4 10 M28 54 h10 M28 62 h9 M92 54 h-10 M93 62 h-9" stroke="#c46f14" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="60" cy="74" rx="18" ry="13" fill="#fff1dc"/><path d="M56 68 h8 l-4 4z" fill="#ff5f9e"/>
<path d="M30 72 h-16 M30 77 l-15 4 M90 72 h16 M90 77 l15 4" stroke="#fff" stroke-width="1.2"/>
<path d="M44 92 q16 8 32 0" stroke="#2bff88" stroke-width="5" fill="none"/><circle cx="60" cy="98" r="4" fill="#ffe14d"/></g></g>
<g class="face">${F(46,74,56,5,'#2bff88',60,76,8)}</g>
<g class="prop"><text x="2" y="30" font-size="12">💤</text></g>`},
peng:{name:'chonk_peng',role:'penguin',svg:`${shadow}<g class="bod">
<ellipse cx="44" cy="132" rx="11" ry="4" fill="#ffb020"/><ellipse cx="76" cy="132" rx="11" ry="4" fill="#ffb020"/>
<ellipse cx="60" cy="84" rx="40" ry="48" fill="#1c2a4a"/><ellipse cx="60" cy="96" rx="28" ry="34" fill="#f7f7fb"/>
<g class="arm arm-l"><path d="M22 80 q-14 20 -4 40 q8 -6 10 -30z" fill="#1c2a4a"/></g><g class="arm arm-r"><path d="M98 80 q14 20 4 40 q-8 -6 -10 -30z" fill="#1c2a4a"/></g>
<g class="head"><path d="M26 56 q34 14 68 0 l0 8 q-34 14 -68 0z" fill="#ff4fa8"/><path d="M80 62 l10 26 l-10 2z" fill="#ff4fa8"/><path d="M30 60 h60" stroke="#ffe14d" stroke-width="2" stroke-dasharray="4 4"/>
<path d="M28 40 Q30 6 60 6 Q90 6 92 40 Q60 30 28 40Z" fill="#2bff88"/><path d="M28 40 Q60 30 92 40 L92 46 Q60 36 28 46Z" fill="#14b765"/><circle cx="60" cy="6" r="7" fill="#fff"/>
<ellipse cx="38" cy="62" rx="5" ry="3" fill="#ff8fc0" opacity=".5"/><ellipse cx="82" cy="62" rx="5" ry="3" fill="#ff8fc0" opacity=".5"/></g></g>
<g class="face">${F(48,72,52,4.6,'#111',60,56,0)}<path d="M53 60 h14 l-7 8z" fill="#ffb020" class="beak"/></g>
<g class="prop"><text x="96" y="30" font-size="12">❄️</text></g>`},
ape:{name:'bored_ish',role:'ape',svg:`${shadow}<g class="bod">
<path d="M28 100 Q60 86 92 100 L96 134 L24 134Z" fill="#ffe14d"/><path d="M44 96 l16 14 l16 -14" stroke="#1b1b2e" stroke-width="3" fill="none"/><text x="52" y="128" font-size="11" font-family="monospace" font-weight="800" fill="#1b1b2e">10K</text>
<g class="arm arm-l"><path d="M30 104 q-12 14 -8 26" stroke="#6b4527" stroke-width="12" fill="none" stroke-linecap="round"/><circle cx="22" cy="130" r="7" fill="#c99b6d"/></g>
<g class="arm arm-r"><path d="M90 104 q12 14 8 26" stroke="#6b4527" stroke-width="12" fill="none" stroke-linecap="round"/><circle cx="98" cy="130" r="7" fill="#c99b6d"/></g>
<g class="head"><circle cx="24" cy="58" r="11" fill="#6b4527"/><circle cx="24" cy="58" r="6" fill="#c99b6d"/><circle cx="96" cy="58" r="11" fill="#6b4527"/><circle cx="96" cy="58" r="6" fill="#c99b6d"/>
<ellipse cx="60" cy="56" rx="34" ry="36" fill="#6b4527"/><path d="M40 30 q20 -8 40 0" stroke="#4e3119" stroke-width="3" fill="none"/>
<ellipse cx="60" cy="72" rx="24" ry="18" fill="#c99b6d"/><ellipse cx="54" cy="66" rx="2" ry="1.5" fill="#3a2410"/><ellipse cx="66" cy="66" rx="2" ry="1.5" fill="#3a2410"/>
<path d="M28 30 Q30 6 60 8 Q90 6 92 30Z" fill="#8b5cff"/><path d="M22 30 h76 v6 h-76z" fill="#6c3fe0"/><path d="M52 18 h16 v6 h-16z" fill="#ffe14d"/></g></g>
<g class="face">${F(47,73,48,4.5,'#ffe14d',60,80,14)}<path class="lids" d="M40 44 h14 M66 44 h14" stroke="#4e3119" stroke-width="4" stroke-linecap="round"/></g>
<g class="prop"><text x="96" y="104" font-size="13">🍌</text></g>`}};
window.CHARS=S;
window.charSVG=k=>`<svg viewBox="0 0 120 140" role="img" aria-label="${S[k].name}, ${S[k].role}" class="cs">${S[k].svg}</svg>`;
window.charFig=(k,cls='')=>`<figure class="ch ${cls}" data-c="${k}" data-face="idle"><div class="ch-in">${charSVG(k)}</div><figcaption>${S[k].name}</figcaption><span class="fx" aria-hidden="true"></span><span class="bubble" aria-hidden="true"></span></figure>`;
})();
