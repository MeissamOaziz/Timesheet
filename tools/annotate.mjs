// Annotation layer injected into the live page before a screenshot is taken.
// Drawing the callouts as real DOM/SVG (rather than painting on the PNG afterwards) keeps
// them vector-crisp at any device scale, and lets them position themselves off the real
// element boxes — so they stay correct when the UI moves in a redesign.

export const ANNOTATE_SRC = `
window.__ann = (function(){
  var C = { accent:'#FF5A36', accentDark:'#D93E1F', ink:'#10131C', paper:'#FFFFFF' };
  var LAYER_ID = '__annLayer';

  function clear(){
    var l = document.getElementById(LAYER_ID);
    if(l) l.remove();
  }

  function layer(){
    var l = document.getElementById(LAYER_ID);
    if(l) return l;
    l = document.createElement('div');
    l.id = LAYER_ID;
    l.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483600;font-family:\\'DM Sans\\',system-ui,sans-serif';
    document.body.appendChild(l);
    return l;
  }

  function rectOf(sel){
    var el = (typeof sel === 'string') ? document.querySelector(sel) : sel;
    if(!el) return null;
    var r = el.getBoundingClientRect();
    if(!r.width && !r.height) return null;
    return { x:r.left + window.scrollX, y:r.top + window.scrollY, w:r.width, h:r.height,
             cx:r.left + window.scrollX + r.width/2, cy:r.top + window.scrollY + r.height/2 };
  }

  // Bright ring around a target so the eye lands on it immediately.
  function ring(sel, pad){
    var r = rectOf(sel); if(!r) return null;
    pad = (pad==null?6:pad);
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:'+(r.x-pad)+'px;top:'+(r.y-pad)+'px;width:'+(r.w+pad*2)+'px;height:'+(r.h+pad*2)+
      'px;border:3px solid '+C.accent+';border-radius:12px;box-shadow:0 0 0 4px rgba(255,90,54,.20),0 8px 26px rgba(255,90,54,.28)';
    layer().appendChild(d);
    return r;
  }

  // Numbered step chip. Corner anchors ('tl','tr','bl','br') sit on the element's corner;
  // 'left'/'right' sit fully outside it, vertically centred — use those on form fields so
  // the chip never lands on top of the field's own label.
  function badge(sel, n, corner){
    var r = rectOf(sel); if(!r) return null;
    corner = corner || 'tl';
    var size = 34, gap = 10, x, y;
    if(corner === 'left' || corner === 'right'){
      x = (corner === 'left') ? (r.x - size - gap) : (r.x + r.w + gap);
      y = r.y + (r.h - size)/2;
    } else {
      x = (corner.indexOf('r')>-1) ? (r.x + r.w - size/2) : (r.x - size/2);
      y = (corner.indexOf('b')>-1) ? (r.y + r.h - size/2) : (r.y - size/2);
    }
    var d = document.createElement('div');
    d.textContent = n;
    d.style.cssText = 'position:absolute;left:'+x+'px;top:'+y+'px;width:'+size+'px;height:'+size+'px;border-radius:50%;'+
      'background:'+C.accent+';color:#fff;font-weight:700;font-size:17px;display:flex;align-items:center;justify-content:center;'+
      'box-shadow:0 4px 14px rgba(255,90,54,.5);border:2.5px solid #fff';
    layer().appendChild(d);
    return r;
  }

  // Pick the side with enough room for the callout, so labels never get crushed against
  // an edge. Explicit sides still win; 'auto' (the default) measures first.
  function bestSide(r, want){
    if(want && want !== 'auto') return want;
    var need = 300, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var space = {
      left:  r.x - window.scrollX,
      right: vw - (r.x - window.scrollX + r.w),
      top:   r.y - window.scrollY,
      bottom:vh - (r.y - window.scrollY + r.h),
    };
    if(space.right >= need) return 'right';
    if(space.left  >= need) return 'left';
    return (space.bottom >= space.top) ? 'bottom' : 'top';
  }

  // Curved arrow from a floating label into the target edge.
  function arrow(sel, opts){
    opts = opts || {};
    var r = rectOf(sel); if(!r) return null;
    var side = bestSide(r, opts.side);
    var len  = opts.len || 132;
    var tipGap = 12;
    var tx, ty, sx, sy, c1x, c1y;
    if(side === 'left'){ tx=r.x-tipGap; ty=r.cy; sx=tx-len; sy=ty-34; c1x=tx-len*0.5; c1y=ty-40; }
    else if(side === 'right'){ tx=r.x+r.w+tipGap; ty=r.cy; sx=tx+len; sy=ty-34; c1x=tx+len*0.5; c1y=ty-40; }
    else if(side === 'top'){ tx=r.cx; ty=r.y-tipGap; sx=tx+40; sy=ty-len; c1x=tx+52; c1y=ty-len*0.5; }
    else { tx=r.cx; ty=r.y+r.h+tipGap; sx=tx+40; sy=ty+len; c1x=tx+52; c1y=ty+len*0.5; }

    var minX=Math.min(sx,tx)-60, minY=Math.min(sy,ty)-60;
    var w=Math.abs(sx-tx)+120, h=Math.abs(sy-ty)+120;
    var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('width',w); svg.setAttribute('height',h);
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    svg.style.cssText='position:absolute;left:'+minX+'px;top:'+minY+'px;overflow:visible';
    var mk = '<marker id="ah'+Math.random().toString(36).slice(2)+'" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'+
             '<path d="M1,1 L11,6 L1,11 z" fill="'+C.accent+'"/></marker>';
    var mid = mk.match(/id="([^"]+)"/)[1];
    svg.innerHTML = '<defs>'+mk+'</defs>'+
      '<path d="M'+(sx-minX)+','+(sy-minY)+' Q'+(c1x-minX)+','+(c1y-minY)+' '+(tx-minX)+','+(ty-minY)+'" '+
      'fill="none" stroke="'+C.accent+'" stroke-width="3.4" stroke-linecap="round" marker-end="url(#'+mid+')"/>';
    layer().appendChild(svg);

    if(opts.text){
      var lab = document.createElement('div');
      lab.textContent = opts.text;
      lab.style.cssText='position:absolute;max-width:270px;background:'+C.accent+';color:#fff;font-size:14.5px;font-weight:600;'+
        'line-height:1.35;padding:9px 14px;border-radius:11px;box-shadow:0 6px 20px rgba(16,19,28,.28);white-space:pre-wrap';
      lab.style.left = sx + 'px'; lab.style.top = sy + 'px';
      layer().appendChild(lab);
      // Keep the label inside the frame.
      var lr = lab.getBoundingClientRect();
      if(side==='left'){ lab.style.left = Math.max(12, sx - lr.width) + 'px'; lab.style.top = (sy - lr.height/2) + 'px'; }
      else if(side==='right'){ lab.style.top = (sy - lr.height/2) + 'px'; }
      else { lab.style.left = Math.max(12, sx - lr.width/2) + 'px'; }
      var after = lab.getBoundingClientRect();
      if(after.right > window.innerWidth - 10) lab.style.left = Math.max(12, window.innerWidth - after.width - 14 + window.scrollX) + 'px';
      if(after.left < 10) lab.style.left = (12 + window.scrollX) + 'px';
    }
    return r;
  }

  // Caption strip. Sits under the app's own nav bar so it never hides real navigation —
  // the point is to explain the screen, not to cover it.
  function title(text){
    // There are two <nav>s in the document (the landing one and the app one) and the hidden
    // one measures 0x0 — so take the tallest *visible* bar pinned to the top.
    var navH = 0;
    Array.prototype.forEach.call(document.querySelectorAll('nav, .nav, header'), function(n){
      var nr = n.getBoundingClientRect();
      if(nr.height > 8 && nr.top < 80) navH = Math.max(navH, nr.bottom);
    });
    var d = document.createElement('div');
    d.id = '__annTitle';
    d.textContent = text;
    d.style.cssText='position:absolute;left:50%;transform:translateX(-50%);top:'+(window.scrollY+navH+16)+'px;'+
      'background:'+C.ink+';color:#fff;font-size:15px;font-weight:600;padding:10px 20px;border-radius:999px;'+
      'box-shadow:0 8px 26px rgba(16,19,28,.32);max-width:80%;text-align:center';
    layer().appendChild(d);
  }

  // Union of everything that matters in this shot (annotations + their targets), so the
  // screenshot can be cropped to the content instead of trailing empty page.
  function bounds(targets){
    var boxes = [];
    // If a dialog is open it IS the subject of the shot — keep its title bar and footer in
    // frame, otherwise the reader can't tell which dialog they're looking at.
    Array.prototype.forEach.call(document.querySelectorAll('.modal-overlay.open .modal'), function(m){
      var b = m.getBoundingClientRect();
      if(b.width && b.height) boxes.push({t:b.top+window.scrollY, b:b.bottom+window.scrollY});
    });
    var l = document.getElementById(LAYER_ID);
    if(l) Array.prototype.forEach.call(l.children, function(c){
      var b = c.getBoundingClientRect();
      if(b.width && b.height) boxes.push({t:b.top+window.scrollY, b:b.bottom+window.scrollY});
    });
    (targets||[]).forEach(function(sel){
      var r = rectOf(sel); if(r) boxes.push({t:r.y, b:r.y+r.h});
    });
    if(!boxes.length) return null;
    return {
      top: Math.min.apply(null, boxes.map(function(b){return b.t;})),
      bottom: Math.max.apply(null, boxes.map(function(b){return b.b;})),
    };
  }

  return { clear:clear, ring:ring, badge:badge, arrow:arrow, title:title, bounds:bounds, rectOf:rectOf };
})();
`;
