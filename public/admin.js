/*
 * Members / admin panel.
 *
 * Rendered into the workspace panel's 成员 tab. Talks only to the hub's
 * /api/state and /api/admin/* endpoints; holds no state beyond the admin token
 * (kept in localStorage). Members are grouped enabled-first, disabled last.
 */
const KEY = 'hub.adminToken';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
function token(){return localStorage.getItem(KEY)||'';}
function setToken(v){if(v)localStorage.setItem(KEY,v);else localStorage.removeItem(KEY);}
function api(path,opts){
  opts=opts||{};
  const headers=Object.assign({'x-admin-token':token()},opts.json?{'content-type':'application/json'}:{});
  return fetch(path,{method:opts.method||'GET',headers:headers,body:opts.json?JSON.stringify(opts.json):undefined}).then(function(r){
    return r.json().catch(function(){return {};}).then(function(b){ if(!r.ok) throw new Error(b.error||('HTTP '+r.status)); return b; });
  });
}
function avHtml(av){
  const v=String(av||'');
  if(/^https?:\/\//.test(v)||/^data:/.test(v)) return '<img src="'+esc(v)+'" alt="">';
  return esc(v||'?');
}
function rowHtml(m){
  const online=m.enabled?(m.online?'在线':'离线'):'已禁用';
  const cls=m.enabled?'':' disabled';
  // Removal is a tombstone in overrides.json, so it is allowed for every
  // member; config-declared ones can be restored from the panel.
  return '<div class="mem-row'+cls+'">'
    +'<button class="mem-av" data-av="'+esc(m.id)+'" title="改头像">'+avHtml(m.avatar)+'</button>'
    +'<div><div class="mem-name">'+esc(m.name)+'<span class="mem-id">'+esc(m.id)+'</span></div>'
    +'<div class="mem-role">'+esc(m.role||'')+'</div>'
    +'<div class="mem-badges"><span class="mem-badge'+(m.enabled&&m.online?' on':'')+'">'+online+'</span><span class="mem-badge">'+esc(m.source||'')+'</span></div></div>'
    +'<div class="mem-ops"><button class="mem-switch" role="switch" aria-checked="'+(m.enabled?'true':'false')+'" data-toggle="'+esc(m.id)+'" aria-label="启用/禁用 '+esc(m.name)+'"></button>'
    +'<button class="mem-rm" data-rm="'+esc(m.id)+'">移除</button></div>'
    +'</div>';
}
export async function mountMembersPanel(body, foot){
  ensureDialogs();
  if(!token()){
    // The member list is public state — always show it read-only, with the
    // unlock bar above it. Only the management controls are gated.
    body.innerHTML='<div class="mem-wrap"><div class="mem-unlock"><input type="password" id="athTok" placeholder="admin token" aria-label="管理员令牌"><button id="athUnlock">解锁</button></div><div class="mem-hint" id="memLockedHint">🔒 只读视图 · 输入 admin token 后可管理成员。</div><div id="memListRO"></div></div>';
    foot.innerHTML='<button class="mem-grant" id="athGrant" disabled>＋ 生成接入协议</button>';
    bindUnlock(body,foot);
    await renderReadOnly(body.querySelector('#memListRO'));
    return;
  }
  await renderList(body,foot);
}
function bindUnlock(body,foot){
  const b=body.querySelector('#athUnlock');
  if(!b)return;
  b.onclick=async function(){
    const v=body.querySelector('#athTok').value.trim();
    if(!v)return;
    const prev=token();
    setToken(v);
    try{
      await api('/api/admin/invites'); // 200 only if the token is valid
      mountMembersPanel(body,foot);
    }catch(e){
      setToken(prev||'');
      const hint=body.querySelector('.mem-hint');
      if(hint) hint.textContent='解锁失败：'+(e.message||'token 无效');
    }
  };
}
async function renderReadOnly(host){
  if(!host) return;
  let state;
  try{ state=await api('/api/state'); }catch(e){ host.innerHTML='<div class="mem-hint">成员列表加载失败：'+esc(e.message)+'</div>'; return; }
  const agents=Object.values(state.agents||{});
  if(!agents.length){ host.innerHTML='<div class="mem-hint">暂无成员</div>'; return; }
  const on=agents.filter(function(a){return a.enabled;});
  const off=agents.filter(function(a){return !a.enabled;});
  const row=function(m){ return '<div class="mem-row disabled">'+avHtml(m.avatar)+'<div><div class="mem-name">'+esc(m.name)+'<span class="mem-id">'+esc(m.id)+'</span></div><div class="mem-role">'+esc(m.role||'')+'</div><div class="mem-badges"><span class="mem-badge'+(m.online?' on':'')+'">'+(m.online?'在线':'离线')+'</span></div></div></div>'; };
  let h='';
  if(on.length) h+='<div class="mem-group"><span>启用 · '+on.length+' 人</span><span>'+on.filter(function(a){return a.online;}).length+' 在线</span></div>'+on.map(row).join('');
  if(off.length) h+='<div class="mem-group"><span>已禁用 · '+off.length+'</span></div>'+off.map(row).join('');
  host.innerHTML=h;
}

async function renderList(body,foot){
  let state;
  try{ state=await api('/api/state'); }
  catch(e){ body.innerHTML='<div class="mem-hint">加载失败：'+esc(e.message)+'</div>'; return; }
  window.__athAgents = state.agents||{};
  const agents=Object.values(state.agents||{});
  const on=agents.filter(function(a){return a.enabled;});
  const off=agents.filter(function(a){return !a.enabled;});
  let gone=[];
  try{ gone=(await api('/api/admin/deleted')).deleted||[]; }catch(e){ gone=[]; }
  let h='<div class="mem-wrap">';
  if(on.length) h+='<div class="mem-group"><span>启用 · '+on.length+' 人</span><span>'+on.filter(function(a){return a.online;}).length+' 在线</span></div>'+on.map(rowHtml).join('');
  if(off.length) h+='<div class="mem-group"><span>已禁用 · '+off.length+'</span></div>'+off.map(rowHtml).join('');
  if(gone.length){
    h+='<div class="mem-group"><span>已移除 · '+gone.length+'</span></span></div>';
    h+=gone.map(function(id){ return '<div class="mem-row disabled"><div class="mem-av">✕</div><div><div class="mem-name">'+esc(id)+'</div><div class="mem-role">已从配置成员中移除</div></div><div class="mem-ops"><button class="mem-rm" data-restore="'+esc(id)+'">恢复</button></div></div>'; }).join('');
  }
  h+='</div>';
  body.innerHTML=h;
  foot.innerHTML='<button class="mem-grant" id="athGrant">＋ 生成接入协议</button>';
  body.querySelectorAll('[data-toggle]').forEach(function(el){
    el.onclick=async function(){
      const id=el.dataset.toggle; const next=el.getAttribute('aria-checked')!=='true';
      try{ await api('/api/admin/agents/'+encodeURIComponent(id)+(next?'/enable':'/disable'),{method:'POST'}); await renderList(body,foot); }
      catch(e){ con('操作失败：'+e.message); }
    };
  });
  body.querySelectorAll('[data-rm]').forEach(function(el){
    el.onclick=function(){ const id=el.dataset.rm; openDelete(id,body,foot); };
  });
  body.querySelectorAll('[data-av]').forEach(function(el){
    el.onclick=function(){ openAvatar(el.dataset.av,body,foot); };
  });
  body.querySelectorAll('[data-restore]').forEach(function(el){
    el.onclick=async function(){
      try{ await api('/api/admin/agents/'+encodeURIComponent(el.dataset.restore)+'/restore',{method:'POST'}); await renderList(body,foot); }
      catch(e){ con('恢复失败：'+e.message); }
    };
  });
  const g=foot.querySelector('#athGrant');
  if(g) g.onclick=function(){ openGrant(body,foot); };
}
function con(msg){ const slot=document.getElementById('toastSlot'); if(!slot){ console.warn(msg); return; } const t=document.createElement('div'); t.className='toast'; t.textContent=msg; slot.appendChild(t); setTimeout(function(){ t.remove(); },2600); }
function dlgErr(dlg,msg){ if(!dlg)return; let e=dlg.querySelector('.ath-err'); if(!e){ e=document.createElement('div'); e.className='ath-warn ath-err'; const body=dlg.querySelector('.ath-dlg-body'); if(body) body.insertBefore(e,body.firstChild); } e.textContent=msg; }
function dlgErrClear(dlg){ const e=dlg&&dlg.querySelector('.ath-err'); if(e) e.remove(); }
function dlgs(){ return document.getElementById('athDialogs'); }
function ensureDialogs(){
  if(dlgs())return;
  const wrap=document.createElement('div'); wrap.id='athDialogs';
  wrap.innerHTML=''
    +'<dialog class="ath-dlg" id="athGrantDlg" aria-labelledby="athGrantT"><div class="ath-dlg-hd"><h2 id="athGrantT">生成接入协议</h2><span class="ath-dlg-tag">一次性凭证</span></div>'
    +'<div class="ath-dlg-body"><div class="ath-grid2"><div class="ath-fld"><label for="gDept">隶属</label><input id="gDept" value="团队"></div><div class="ath-fld"><label for="gName">名称</label><input id="gName" value=""></div></div>'
    +'<div class="ath-grid2"><div class="ath-fld"><label for="gId">agent id</label><input id="gId" value=""></div><div class="ath-fld"><label for="gRole">角色</label><input id="gRole" value=""></div></div>'
    +'<div class="ath-fld"><label for="gAvatar">头像（emoji / 图片 URL，可留空）</label><input id="gAvatar" value=""></div>'
    +'<div class="ath-fld"><label for="gTtl">接入码有效期</label><select id="gTtl"><option value="7200">2 小时</option><option value="1800">30 分钟</option><option value="14400">4 小时</option><option value="86400">24 小时</option></select></div></div>'
    +'<div class="ath-dlg-ft"><button class="ath-ghost" data-close="athGrantDlg">取消</button><button class="ath-go" id="gGo">生成</button></div></dialog>'
    +'<dialog class="ath-dlg" id="athProtoDlg" aria-labelledby="athProtoT"><div class="ath-dlg-hd"><h2 id="athProtoT">接入协议包</h2><span class="ath-dlg-tag" id="athProtoTtl"></span></div>'
    +'<div class="ath-dlg-body"><div class="ath-warn">⚠️ 下方接入码为一次性凭证（uses=1）。复制给目标 agent 后请勿转发；用后即废，遗失需重新生成。</div>'
    +'<div class="ath-code"><button class="ath-copy" id="athCopy" aria-label="复制协议">⧉</button><span class="ath-tip" role="status"></span><pre id="athProtoText"></pre></div></div>'
    +'<div class="ath-dlg-ft"><button class="ath-ghost" data-close="athProtoDlg">关闭</button></div></dialog>'
    +'<dialog class="ath-dlg" id="athAvDlg" aria-labelledby="athAvT"><div class="ath-dlg-hd"><h2 id="athAvT">修改头像</h2><span class="ath-dlg-tag" id="athAvName"></span></div>'
    +'<div class="ath-dlg-body"><div class="ath-avprev" id="athAvPrev">?</div>'
    +'<div class="ath-fld"><label for="avEmoji">emoji</label><input id="avEmoji" maxlength="16"></div>'
    +'<div class="ath-fld"><label for="avUrl">图片 URL</label><input id="avUrl" placeholder="https://..."></div>'
    +'<div class="ath-fld"><label>上传图片<input type="file" id="avFile" accept="image/*" hidden style="display:none"><button type="button" class="ath-ghost" id="avPick" style="margin-top:4px">选择文件</button></label></div></div>'
    +'<div class="ath-dlg-ft"><button class="ath-ghost" data-close="athAvDlg">取消</button><button class="ath-go" id="avSave">保存</button></div></dialog>'
    +'<dialog class="ath-dlg" id="athDelDlg" aria-labelledby="athDelT"><div class="ath-dlg-hd"><h2 id="athDelT">移除成员</h2><span class="ath-dlg-tag">不可撤销</span></div>'
    +'<div class="ath-dlg-body"><p id="athDelDesc" style="font-size:14px;line-height:1.6;color:#71767b;margin:0"></p></div>'
    +'<div class="ath-dlg-ft"><button class="ath-ghost" data-close="athDelDlg">取消</button><button class="ath-danger" id="athDelGo">确认移除</button></div></dialog>';
  document.body.appendChild(wrap);
  wrap.querySelectorAll('[data-close]').forEach(function(b){ b.onclick=function(){ document.getElementById(b.dataset.close).close(); }; });
}
function openGrant(body,foot){
  const d=document.getElementById('athGrantDlg');
  dlgErrClear(d);
  ['gName','gId','gRole','gAvatar'].forEach(function(id){ const el=document.getElementById(id); if(el) el.value=''; });
  d.querySelector('#gGo').onclick=async function(){
    const payload={dept:document.getElementById('gDept').value,name:document.getElementById('gName').value,id:document.getElementById('gId').value,role:document.getElementById('gRole').value,avatar:document.getElementById('gAvatar').value,ttlSec:Number(document.getElementById('gTtl').value)};
    if(!payload.id){ dlgErr(document.getElementById('athGrantDlg'),'请填 agent id'); return; }
    try{
      const r=await api('/api/admin/grant',{method:'POST',json:payload});
      d.close();
      const pd=document.getElementById('athProtoDlg');
      document.getElementById('athProtoText').textContent=r.protocol;
      document.getElementById('athProtoTtl').textContent='有效 '+r.ttlMinutes+' 分钟';
      pd.showModal();
    }catch(e){ dlgErr(document.getElementById('athGrantDlg'),'生成失败：'+e.message); }
  };
  d.showModal();
}
function openDelete(id,body,foot){
  const d=document.getElementById('athDelDlg');
  document.getElementById('athDelDesc').textContent='将移除「'+id+'」。来自加入码的成员移除后 token 立即失效；再次加入需重新生成接入协议。';
  d.querySelector('#athDelGo').onclick=async function(){
    try{ await api('/api/admin/agents/'+encodeURIComponent(id),{method:'DELETE'}); d.close(); await renderList(body,foot); }
    catch(e){ con('移除失败：'+e.message); }
  };
  d.showModal();
}
function openAvatar(id,body,foot){
  const d=document.getElementById('athAvDlg');
  document.getElementById('athAvName').textContent=id;
  const prev=document.getElementById('athAvPrev');
  const em=document.getElementById('avEmoji'); const ur=document.getElementById('avUrl');
  function setPrev(v){ prev.innerHTML=(/^https?:\/\//.test(v)||/^data:/.test(v))?'<img src="'+esc(v)+'" alt="">':esc(v||'?'); }
  const st=(window.__athAgents||{})[id];
  em.value=(st&&st.avatar&&!/^https?:|^data:/.test(st.avatar))?st.avatar:'';
  ur.value=(st&&st.avatar&&/^https?:|^data:/.test(st.avatar))?st.avatar:'';
  setPrev((st&&st.avatar)||'');
  em.oninput=function(){ ur.value=''; setPrev(em.value.trim()); };
  ur.oninput=function(){ if(ur.value.trim()){ em.value=''; setPrev(ur.value.trim()); } };
  document.getElementById('avPick').onclick=function(){ document.getElementById('avFile').click(); };
  document.getElementById('avFile').onchange=function(e){ const f=e.target.files[0]; if(!f)return; const rd=new FileReader(); rd.onload=function(){ ur.value=rd.result; em.value=''; setPrev(rd.result); }; rd.readAsDataURL(f); };
  document.getElementById('avSave').onclick=async function(){
    const v=ur.value.trim()||em.value.trim()||'';
    try{ await api('/api/admin/agents/'+encodeURIComponent(id)+'/avatar',{method:'POST',json:{avatar:v}}); d.close(); await renderList(body,foot); }
    catch(e){ dlgErr(document.getElementById('athAvDlg'),'保存失败：'+e.message); }
  };
  d.showModal();
}
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); return true; }catch(e){ return false; }
}
document.addEventListener('click',async function(e){
  if(e.target&&e.target.id==='athCopy'){
    const ok=await copyText(document.getElementById('athProtoText').textContent);
    const tip=e.target.parentElement.querySelector('.ath-tip');
    e.target.setAttribute(ok?'data-copied':'data-failed','');
    e.target.textContent=ok?'✓':'!';
    if(tip) tip.textContent=ok?'已复制':'复制失败';
    setTimeout(function(){ e.target.removeAttribute('data-copied'); e.target.removeAttribute('data-failed'); e.target.textContent='⧉'; if(tip) tip.textContent=''; },2000);
  }
},{capture:true});