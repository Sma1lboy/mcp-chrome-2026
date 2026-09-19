/**
 * Page-side scripts for chrome_step.
 *
 * Ported from browser-use/jev-ultrafast (`jev_ultrafast/snapshot.js` and the
 * inline act/guard expressions in `jev_ultrafast/browser.py`), trimmed to the
 * CLICK / TYPE_TEXT scope. Original is MIT-licensed.
 *
 * Two expressions, each run as a single CDP Runtime.evaluate:
 *
 * - SNAPSHOT_JS  reads the whole observable page in one pass: visible
 *                interactive elements with role/name/value/state, the visible
 *                text, a per-element guard, and a whole-page marker.
 * - RESOLVE_JS   re-checks a chosen element against its guard and the page
 *                marker, then resolves current geometry and hit-tests it.
 *                Verification and geometry share one evaluate so the page
 *                cannot change between the two.
 *
 * Both keep their element table in `window.__chromeStep`, so the ids the model
 * chooses always refer to DOM nodes this code observed, never to a selector or
 * coordinate the model produced.
 */

/** Cap on elements handed to the model; the rest are reported as omitted. */
export const MAX_ELEMENTS = 250;

/** Cap on visible page text handed to the model, in characters. */
export const MAX_TEXT = 6000;

const SHARED = `
  const cache = window.__chromeStep ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  // Document-level state: anything here changing invalidates every decision.
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  // Element-level state: identity, semantics, and the text of the row/form/dialog
  // it sits in, so a reordered list cannot silently move the target.
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,${MAX_TEXT})||''];
  };
`;

export const SNAPSHOT_JS = `(() => {
  if (!document.body) return null;
  ${SHARED}
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(r=>'[role="'+r+'"]').join(',');
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
      (['textbox','searchbox','spinbutton'].includes(rname) ||
        (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
    const value='value' in e ? String(e.value) :
      e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
    actions.push({...base,kind:editable?'fill':'click',value});
    // An editable combobox is also worth opening without typing.
    if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<${MAX_TEXT}) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\\n').slice(0,${MAX_TEXT});
  const pageKey=cache.pageKey();
  const omitted=Math.max(0,actions.length-${MAX_ELEMENTS});
  actions.splice(${MAX_ELEMENTS});
  actions.forEach((a,i)=>a.id='e'+(i+1));
  const guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity only. Geometry is resolved and hit-tested again
  // immediately before input, so layout drift alone does not invalidate a decision.
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,actions,pageKey[6]];
  return {url:location.href,title:document.title,text,
    scroll:{y:scrollY,height:document.documentElement.scrollHeight},
    actions,marker,pageKey,guards,omitted};
})()`;

/**
 * Verify one chosen action against the snapshot, then resolve where to click.
 *
 * Returns `{x,y}` when every layer still holds, or `{reject:<reason>}`. It never
 * mutates the page: the caller dispatches the input events.
 */
export const RESOLVE_JS = (payload: string) => `((input) => {
  ${SHARED}
  const e=cache.nodes.get(input.node);
  if (!e) return {reject:'element is no longer tracked'};
  if (JSON.stringify(cache.pageKey())!==JSON.stringify(input.pageKey))
    return {reject:'page changed since the decision'};
  if (JSON.stringify(cache.guard(e))!==JSON.stringify(input.guard))
    return {reject:'element or its surrounding context changed since the decision'};
  if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]'))
    return {reject:'element is disabled'};
  if (input.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true'))
    return {reject:'field is read-only'};
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight)
    return {reject:'element is outside the viewport'};
  if (!e.contains(document.elementFromPoint(x,y)))
    return {reject:'element is covered by another element'};
  return {x,y};
})(${payload})`;
